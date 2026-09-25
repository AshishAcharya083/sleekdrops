// What the admin Channels screen reads and does: each connection as an
// operator needs to see it, the per-channel queue behind it, and the handful of
// moves that recover a stuck item without a deploy.
//
// Two rules hold for everything exported here. No value behind a token_ref is
// ever returned, logged or put in an error - a connection reports whether its
// secret is present and where it came from, never what it is. And nothing here
// names a network: a second provider shows up in these views, and connects
// through them, by registering an adapter.
import { q } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import {
  credentialSource,
  getConnection,
  isChannelTokenRef,
  listConnections,
  recordTokenExpiry,
  redactToken,
  removeCredential,
  resolveCredential,
  setConnectionStatus,
  storeCredential,
  tokenStaleness,
  tokenTier,
  upsertConnection,
  type CredentialSource,
  type TokenStaleness,
  type TokenTier,
} from './channels.js';
import { getProvider, registeredProviders } from './providers.js';
import { configuredPlacement, renderPayload } from './queue.js';
import {
  PermanentProviderError,
  toDistributionItem,
  type AuthTokenDetails,
  type ChannelConnectionRow,
  type ChannelStatus,
  type DistributableArticle,
  type DistributionItem,
  type DistributionQueueRow,
  type LinkBudget,
  type LinkPlacement,
} from './types.js';

const log = createLogger('distribution');

/** A request the operator can correct, with the status the API answers it with. */
export class ChannelAdminError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(status: 400 | 404 | 409 | 502, message: string) {
    super(message);
    this.name = 'ChannelAdminError';
    this.status = status;
  }
}

// ── The queue, filtered the way the panel's chips are ──────────────────────

/**
 * The panel's queue filters. 'held' includes an item waiting at the readiness
 * gate, because to an operator that is a post not going out yet and saying why
 * - it just needs nothing from them - and 'pending' is therefore only what is
 * queued, backing off or mid-post.
 */
export type QueueFilter = 'all' | 'pending' | 'held' | 'failed' | 'posted';

export const QUEUE_FILTERS: readonly QueueFilter[] = ['all', 'pending', 'held', 'failed', 'posted'];

export function isQueueFilter(value: unknown): value is QueueFilter {
  return typeof value === 'string' && (QUEUE_FILTERS as readonly string[]).includes(value);
}

const AT_READINESS_GATE = `(item.status = 'pending' AND item.readiness_started_at IS NOT NULL)`;

const FILTER_SQL: Record<QueueFilter, string> = {
  all: 'true',
  pending: `(item.status = 'posting' OR (item.status = 'pending' AND item.readiness_started_at IS NULL))`,
  held: `(item.status = 'held' OR ${AT_READINESS_GATE})`,
  failed: `item.status = 'failed'`,
  posted: `item.status = 'posted'`,
};

export type QueueCounts = Record<QueueFilter, number>;

function emptyCounts(): QueueCounts {
  return { all: 0, pending: 0, held: 0, failed: 0, posted: 0 };
}

/** Every channel's chip counts in one pass, keyed by connection id. */
export async function queueCountsByChannel(): Promise<Map<string, QueueCounts>> {
  const rows = await q<Record<QueueFilter, number> & { channel_connection_id: string }>(
    `SELECT item.channel_connection_id,
            count(*)::int AS "all",
            ${QUEUE_FILTERS.filter((f) => f !== 'all')
              .map((filter) => `count(*) FILTER (WHERE ${FILTER_SQL[filter]})::int AS "${filter}"`)
              .join(',\n            ')}
       FROM distribution_queue item
      GROUP BY item.channel_connection_id`,
  );
  const counts = new Map<string, QueueCounts>();
  for (const row of rows) {
    const entry = emptyCounts();
    for (const filter of QUEUE_FILTERS) entry[filter] = Number(row[filter] ?? 0);
    counts.set(row.channel_connection_id, entry);
  }
  return counts;
}

/** One queue row as the panel's table and drawer render it. */
export interface QueueItemView extends DistributionItem {
  /** The article's headline, or null when the article has since been deleted. */
  title: string | null;
  /** Where the post lives on the network, when it landed and the adapter can say. */
  remoteUrl: string | null;
}

function toQueueItemView(row: DistributionQueueRow & { title: string | null }): QueueItemView {
  const item = toDistributionItem(row);
  const provider = getProvider(item.provider);
  return {
    ...item,
    title: row.title,
    remoteUrl:
      item.remotePostId && provider?.postUrl ? provider.postUrl(item.remotePostId) : null,
  };
}

/**
 * One channel's queue under one filter. Held and failed items first - they are
 * the ones waiting on a person - then everything else by most recent change.
 */
export async function channelQueue(
  channelId: string,
  filter: QueueFilter,
  limit: number,
): Promise<QueueItemView[]> {
  const rows = await q<DistributionQueueRow & { title: string | null }>(
    `SELECT item.*, article.title
       FROM distribution_queue item
       LEFT JOIN articles article ON article.id = item.article_id
      WHERE item.channel_connection_id = $1 AND ${FILTER_SQL[filter]}
      ORDER BY CASE WHEN item.status IN ('held', 'failed') THEN 0 ELSE 1 END,
               item.updated_at DESC
      LIMIT $2`,
    [channelId, limit],
  );
  return rows.map(toQueueItemView);
}

export interface MetricReading {
  fetched_at: string;
  impressions: number | null;
  clicks: number | null;
  reactions: number | null;
}

/** One item for the queue drawer, with the insights readings taken against it. */
export async function queueItemDetail(
  id: string,
): Promise<{ item: QueueItemView; metrics: MetricReading[] } | null> {
  const [row] = await q<DistributionQueueRow & { title: string | null }>(
    `SELECT item.*, article.title
       FROM distribution_queue item
       LEFT JOIN articles article ON article.id = item.article_id
      WHERE item.id = $1`,
    [id],
  );
  if (!row) return null;
  const metrics = await q<MetricReading>(
    `SELECT fetched_at, impressions, clicks, reactions
       FROM distribution_metrics WHERE queue_item_id = $1
      ORDER BY fetched_at DESC LIMIT 20`,
    [id],
  );
  return { item: toQueueItemView(row), metrics };
}

// ── Recovering an item ─────────────────────────────────────────────────────

/** What a manual move did, item by item. */
export interface RecoveryOutcome {
  updated: string[];
  /** Ids that were not in the state the move applies to (or do not exist). */
  skipped: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Put items back in the queue, due now, with a fresh round of attempts and a
 * fresh readiness window. A person deciding to try again is a new decision,
 * not the next backoff of the old one: an item failed for spending all five
 * attempts would otherwise fail again on its first call. `last_error` stays
 * until the next attempt replaces it, so the panel still says what went wrong
 * last time.
 */
async function requeue(ids: string[], from: 'failed' | 'held'): Promise<RecoveryOutcome> {
  const valid = [...new Set(ids.filter(isUuid))];
  const rows =
    valid.length === 0
      ? []
      : await q<{ id: string }>(
          `UPDATE distribution_queue
              SET status = 'pending', attempts = 0, scheduled_at = now(),
                  readiness_started_at = NULL, hold_reason = NULL,
                  claimed_by = NULL, claimed_at = NULL, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND status = $2
            RETURNING id`,
          [valid, from],
        );
  const updated = rows.map((row) => row.id);
  const skipped = ids.filter((id) => !updated.includes(id));
  if (updated.length > 0) {
    log.info(from === 'failed' ? 'distribution items retried' : 'distribution items released', {
      items: updated.length,
      skipped: skipped.length,
    });
  }
  return { updated, skipped };
}

/** Manual retry: a failed item goes back in the queue. */
export function retryFailedItems(ids: string[]): Promise<RecoveryOutcome> {
  return requeue(ids, 'failed');
}

/** Manual release: a held item goes back in the queue. */
export function releaseHeldItems(ids: string[]): Promise<RecoveryOutcome> {
  return requeue(ids, 'held');
}

/**
 * Change where one item's link goes before it is sent.
 *
 * The payload is reset to the baseline for the new placement rather than
 * patched: a payload the renderer already composed carries a cue, a UTM tag
 * and possibly a card made for the old placement, and the worker never renders
 * over a composed one. The baseline has no `renderedAt`, so the next attempt
 * composes the post afresh for the placement asked for here.
 */
export async function overridePlacement(
  id: string,
  placement: LinkPlacement,
): Promise<QueueItemView> {
  const [current] = await q<
    Pick<DistributionQueueRow, 'status' | 'slug' | 'provider'> & {
      article: DistributableArticle | null;
    }
  >(
    `SELECT item.status, item.slug, item.provider,
            CASE WHEN article.id IS NULL THEN NULL ELSE json_build_object(
              'id', article.id, 'slug', article.slug, 'title', article.title,
              'frontmatter', article.frontmatter, 'hero_image_url', article.hero_image_url,
              'hero_image_source', article.hero_image_source, 'keyword_plan', article.keyword_plan
            ) END AS article
       FROM distribution_queue item
       LEFT JOIN articles article ON article.id = item.article_id
      WHERE item.id = $1`,
    [id],
  );
  if (!current) throw new ChannelAdminError(404, 'no queue item with that id');
  if (!current.article) {
    throw new ChannelAdminError(
      409,
      'the article behind this item has been deleted, so the post cannot be re-composed for another placement',
    );
  }
  const payload = renderPayload(
    { ...current.article, slug: current.slug },
    current.provider,
    placement,
  );
  const [row] = await q<DistributionQueueRow>(
    `UPDATE distribution_queue
        SET placement = $2, payload = $3::jsonb, updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'held', 'failed')
      RETURNING *`,
    [id, placement, JSON.stringify(payload)],
  );
  if (!row) {
    throw new ChannelAdminError(
      409,
      current.status === 'posted'
        ? 'this item has already been posted'
        : 'this item is being posted right now - wait for the attempt to finish',
    );
  }
  log.info('distribution placement overridden', { queue_item_id: id, placement });
  const detail = await queueItemDetail(id);
  return detail!.item;
}

// ── Channels ────────────────────────────────────────────────────────────────

/** A connection as the Channels list renders it. Never a token value. */
export interface ChannelView {
  id: string;
  provider: string;
  externalAccountId: string;
  displayName: string | null;
  /** The name of the secret, so an operator knows what to rotate. */
  tokenRef: string;
  status: ChannelStatus;
  /** When the status last changed - "rejected since" on a needs_reauth row. */
  statusSince: string;
  token: TokenStaleness;
  tokenTier: TokenTier;
  adapterInstalled: boolean;
  /** Presence-only readback: whether the secret is configured, and where. */
  credential: { stored: boolean; source: CredentialSource | null };
  /** The placement new items for this network are queued with, and the setting that said so. */
  placement: { value: LinkPlacement; setting: string };
  /** The network's monthly body-link allowance, when it rations one. */
  linkBudget: LinkBudget | null;
  counts: QueueCounts;
}

async function linkBudgetFor(connection: ChannelConnectionRow): Promise<LinkBudget | null> {
  const provider = getProvider(connection.provider);
  if (!provider?.linkBudget) return null;
  try {
    return await provider.linkBudget(connection.external_account_id);
  } catch (err) {
    // A figure the panel cannot read is left out rather than failing the list.
    log.warn('link budget unavailable', {
      channel_connection_id: connection.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function channelView(
  connection: ChannelConnectionRow,
  counts: Map<string, QueueCounts>,
  now: Date,
): Promise<ChannelView> {
  const [source, placement, linkBudget] = await Promise.all([
    credentialSource(connection.token_ref, connection.provider),
    configuredPlacement(connection.provider),
    linkBudgetFor(connection),
  ]);
  return {
    id: connection.id,
    provider: connection.provider,
    externalAccountId: connection.external_account_id,
    displayName: connection.display_name,
    tokenRef: connection.token_ref,
    status: connection.status,
    statusSince: connection.updated_at,
    token: tokenStaleness(connection.expires_at, now),
    tokenTier: tokenTier(connection.expires_at, now),
    adapterInstalled: registeredProviders().includes(connection.provider),
    credential: { stored: source !== null, source },
    placement: { value: placement.placement, setting: placement.setting },
    linkBudget,
    counts: counts.get(connection.id) ?? emptyCounts(),
  };
}

export async function channelViews(now: Date = new Date()): Promise<ChannelView[]> {
  const [connections, counts] = await Promise.all([listConnections(), queueCountsByChannel()]);
  return Promise.all(connections.map((connection) => channelView(connection, counts, now)));
}

async function viewOf(id: string): Promise<ChannelView> {
  const connection = await getConnection(id);
  if (!connection) throw new ChannelAdminError(404, 'no channel with that id');
  return channelView(connection, await queueCountsByChannel(), new Date());
}

/** A secret name the environment could also carry: `facebook-page-token`. */
const TOKEN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Ask the network who a credential posts as. Every message that comes back is
 * scrubbed of the credential that was sent and of any the network handed back
 * in exchange, because the pasted value is exactly what must not be echoed.
 */
async function authenticateWith(provider: string, token: string): Promise<AuthTokenDetails> {
  const adapter = getProvider(provider);
  if (!adapter) throw new ChannelAdminError(400, `no adapter is installed for ${provider}`);
  try {
    return await adapter.authenticate({ token });
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err), token);
    if (err instanceof PermanentProviderError) throw new ChannelAdminError(400, message);
    throw new ChannelAdminError(502, `${provider} could not be reached to check that token: ${message}`);
  }
}

/**
 * The secret name a new connection stores its token under: whatever the
 * operator named, else the name this account already used, else the adapter's
 * documented default - suffixed with the account id when a different account
 * already holds that name, so two Pages never share a token. A name the
 * operator typed that another account's connection already reads is refused
 * rather than suffixed: storing under it would silently replace that
 * channel's token with this one.
 */
async function chooseTokenRef(
  provider: string,
  externalAccountId: string,
  requested: string | null,
): Promise<string> {
  const connections = await listConnections();
  const isThisAccount = (connection: ChannelConnectionRow) =>
    connection.provider === provider && connection.external_account_id === externalAccountId;
  if (requested) {
    const holder = connections.find(
      (connection) => connection.token_ref === requested && !isThisAccount(connection),
    );
    if (holder) {
      throw new ChannelAdminError(
        409,
        `the secret name ${requested} is already used by ${holder.provider} channel ` +
          `${holder.display_name || holder.external_account_id} - choose another name, ` +
          'or leave it empty and one is chosen for this account',
      );
    }
    return requested;
  }
  const existing = connections.find(isThisAccount);
  if (existing) return existing.token_ref;
  const fallback = getProvider(provider)?.defaultTokenRef ?? `${provider}-token`;
  const taken = connections.some((connection) => connection.token_ref === fallback);
  return taken ? `${fallback}-${externalAccountId}` : fallback;
}

/**
 * Connect an account from a pasted credential, or from a secret the deployment
 * already mounts when only its name is given. The network is asked who the
 * credential posts as before anything is stored, so a wrong or unscoped token
 * is refused with the network's reason instead of becoming a channel that
 * fails every post.
 */
export async function connectChannel(input: {
  provider?: unknown;
  token?: unknown;
  tokenRef?: unknown;
}): Promise<ChannelView> {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  if (!provider) throw new ChannelAdminError(400, 'provider is required');
  if (!getProvider(provider)) {
    throw new ChannelAdminError(400, `no adapter is installed for ${provider}`);
  }
  const requestedRef = typeof input.tokenRef === 'string' ? input.tokenRef.trim() : '';
  if (requestedRef && !TOKEN_REF_RE.test(requestedRef)) {
    throw new ChannelAdminError(
      400,
      'the secret name may use letters, digits, dots, dashes and underscores (up to 100)',
    );
  }
  if (requestedRef && !isChannelTokenRef(requestedRef, provider)) {
    throw new ChannelAdminError(
      400,
      `the secret name must start with ${provider}- or channel- and name a token for this channel, ` +
        "not one of the platform's own settings",
    );
  }
  const pasted = typeof input.token === 'string' ? input.token.trim() : '';

  let token = pasted;
  if (!token) {
    const mounted = requestedRef ? await resolveCredential(requestedRef, provider) : null;
    if (!mounted) {
      throw new ChannelAdminError(
        400,
        requestedRef
          ? `no secret named ${requestedRef} is configured - paste the token instead`
          : 'paste an access token, or name a secret the deployment already mounts',
      );
    }
    token = mounted;
  }

  const details = await authenticateWith(provider, token);
  const tokenRef = await chooseTokenRef(provider, details.externalAccountId, requestedRef || null);
  if (pasted) {
    await storeCredential(tokenRef, details.accessToken);
  } else if (details.accessToken !== token) {
    // The mounted secret is a user token the network exchanged for an account
    // token. Writing the exchanged one into the database would quietly move
    // the credential out of the secret store the operator chose.
    throw new ChannelAdminError(
      400,
      `${requestedRef} holds a user token rather than the account's own token - mount the account token under that name, or paste it here`,
    );
  }
  const row = await upsertConnection({
    provider,
    externalAccountId: details.externalAccountId,
    displayName: details.displayName || null,
    tokenRef,
    expiresInSeconds: details.expiresIn,
  });
  return viewOf(row.id);
}

/**
 * Replace the credential behind an existing channel. Refused when the new
 * token posts as a different account: that is a second channel, and silently
 * re-pointing this one would move its queue to a Page nobody chose.
 */
export async function replaceCredential(id: string, token: unknown): Promise<ChannelView> {
  const connection = await getConnection(id);
  if (!connection) throw new ChannelAdminError(404, 'no channel with that id');
  const pasted = typeof token === 'string' ? token.trim() : '';
  if (!pasted) throw new ChannelAdminError(400, 'paste the new access token');

  const details = await authenticateWith(connection.provider, pasted);
  if (details.externalAccountId !== connection.external_account_id) {
    throw new ChannelAdminError(
      409,
      `that token posts as ${details.displayName || details.externalAccountId} ` +
        `(${details.externalAccountId}), not this channel's account ` +
        `(${connection.external_account_id}) - connect it as a new channel instead`,
    );
  }
  await storeCredential(connection.token_ref, details.accessToken);
  await recordTokenExpiry(id, details.expiresIn);
  if (details.displayName) {
    await q('UPDATE channel_connections SET display_name = $2 WHERE id = $1', [
      id,
      details.displayName,
    ]);
  }
  log.info('channel credential replaced', {
    channel_connection_id: id,
    provider: connection.provider,
    token_ref: connection.token_ref,
  });
  return viewOf(id);
}

/**
 * Stop posting to a channel. The connection is disabled rather than deleted:
 * deleting it would cascade through its queue and take the posting history and
 * insights with it. A pasted credential is forgotten unless another live
 * connection reads the same name; a secret the deployment mounts is reported,
 * because only the deployment can remove it.
 */
export async function disconnectChannel(id: string): Promise<{
  channel: ChannelView;
  credentialRemoved: boolean;
  environmentSecret: boolean;
}> {
  const connection = await getConnection(id);
  if (!connection) throw new ChannelAdminError(404, 'no channel with that id');
  await setConnectionStatus(id, 'disabled');

  const sharing = (await listConnections()).some(
    (other) =>
      other.id !== id && other.token_ref === connection.token_ref && other.status !== 'disabled',
  );
  const before = await credentialSource(connection.token_ref, connection.provider);
  let credentialRemoved = false;
  if (!sharing && before === 'panel') {
    await removeCredential(connection.token_ref);
    credentialRemoved = true;
  }
  const after = await credentialSource(connection.token_ref, connection.provider);
  return { channel: await viewOf(id), credentialRemoved, environmentSecret: after === 'environment' };
}
