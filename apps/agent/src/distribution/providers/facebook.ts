// The Facebook Page adapter: the only module in the agent that knows what a
// Graph API call looks like. Everything above it addresses a Page through
// SocialProvider.
//
// Three things shape this file, and none of them are obvious from the
// interface it implements.
//
//   * Meta caps a non-subscribing Page at roughly two organic link posts a
//     month. Sleekdrops publishes on a scout interval, not twice a month, so a
//     "just post the link" adapter stalls after two articles and fails every
//     item after that with an OAuthException-shaped error that reads like a
//     dead token. So the body link is a counted resource: the count is checked
//     before the call, and an item that cannot afford one is re-composed with
//     the link in the first comment rather than spent on a rejection.
//   * A first-comment post forfeits the Open Graph card, which promotes the
//     image from a nicety to a precondition - and the only image we may upload
//     is one we made (a native upload grants Meta a sublicensable licence).
//     The renderer settles that; what arrives here is `imageUrl` non-null for
//     an image we may upload, and a placement already resolved to 'in_body'
//     when there was none. The ladder below picks up from there.
//   * The first comment is a second write that can fail on its own, and a post
//     that is live with no link anywhere is worse than either placement. So a
//     comment that will not go up is answered with an edit that appends the URL
//     to the caption, and the row is marked degraded rather than retried -
//     retrying would post the article twice.
//
// Nothing here writes copy: the caption, the cue, the disclosure and the UTM
// tagging are the renderer's (distribution/render). And nothing here hands a
// token to anything that is read back: it authorises calls through an
// Authorization header rather than a query parameter, the one call whose
// subject is the token itself (debug_token) is never quoted in a message, and
// every error and log line the adapter writes is scrubbed of it.
import { config } from '../../config.js';
import { getSetting, q, setSetting } from '../../db/pool.js';
import { createLogger } from '../../lib/log.js';
import {
  findConnection,
  getConnection,
  recordTokenExpiry,
  redactToken,
  setConnectionStatus,
} from '../channels.js';
import { storeRenderedPayload } from '../queue.js';
import { render, renderForItem } from '../render/index.js';
import {
  PermanentProviderError,
  ProviderHoldError,
  type AuthenticateParams,
  type AuthTokenDetails,
  type ChannelConnectionRow,
  type ChannelStatus,
  type DistributableArticle,
  type DistributionItem,
  type InsightSnapshot,
  type LinkBudget,
  type LinkPlacement,
  type PostReceipt,
  type ProviderInsightsContext,
  type ProviderPostContext,
  type RenderedPayload,
  type SocialProvider,
} from '../types.js';

const log = createLogger('distribution');

/** The `provider` value this adapter's connections and queue items carry. */
export const FACEBOOK_PROVIDER = 'facebook';

const GRAPH_HOST = 'https://graph.facebook.com';

/** One Graph call's wall-clock budget. Comfortably inside the posting lease. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * How many times the first comment is attempted before the caption edit takes
 * over, and the delay between attempts (doubling). Three is enough to ride out
 * the transient 500 the comments edge returns seconds after a photo post while
 * the post is still settling, and short enough that the whole flow stays well
 * inside one claim.
 */
const COMMENT_ATTEMPTS = 3;
const COMMENT_RETRY_MS = 2_000;

/** The permissions every call below needs, named wherever one is refused. */
export const REQUIRED_SCOPES = 'pages_manage_posts, pages_read_engagement and pages_manage_engagement';

/**
 * Aggregate post-level counters, and deliberately only those: no commenter
 * identities, no comment text, no demographic breakdowns, which is what keeps
 * distribution outside personal-data handling.
 */
const INSIGHT_METRICS = ['post_impressions', 'post_clicks', 'post_reactions_by_type_total'];

/** Where the API's own verdict on the monthly link cap is remembered. */
export const BODY_LINK_BUDGET_SETTING = 'facebook_body_link_budget';

/** One Page's exhausted month, as the settings row holds it. */
interface BudgetState {
  [pageId: string]: { month: string; exhaustedAt: string };
}

// ── The Graph client ────────────────────────────────────────────────────────

/** What Graph puts in the `error` object of a failed call. */
interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
}

/**
 * A call Graph refused. Carries the codes the mapping below turns into an
 * actionable message, and a `detail` that is Meta's own wording - which is the
 * part an operator searches for.
 */
class GraphCallError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly status: number;
  readonly detail: string;

  constructor(path: string, status: number, error: GraphErrorBody | null, body: string) {
    const detail = error?.error_user_msg || error?.message || body.slice(0, 300) || `HTTP ${status}`;
    super(`Facebook refused ${path}: ${detail}`);
    this.name = 'GraphCallError';
    this.status = status;
    this.code = typeof error?.code === 'number' ? error.code : null;
    this.subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
    this.detail = detail;
  }
}

/** Codes Graph uses for a credential that will not work again as it is. */
const TOKEN_CODES = new Set([102, 190, 463, 467]);

/** Codes Graph uses for a call this token is not scoped for. */
const PERMISSION_CODES = new Set([3, 10, 200, 299]);

interface GraphCall {
  path: string;
  method?: 'GET' | 'POST';
  /** The credential, sent as a bearer header. Null for the OAuth endpoints. */
  token: string | null;
  params?: Record<string, string>;
}

/**
 * One Graph call. Parameters go in the query on a GET and in a form body on a
 * POST, and the credential authorising the call goes in neither: it is a bearer
 * header, so a URL that ends up in a log or an error carries no token.
 */
async function graph<T>(call: GraphCall, rt: Runtime): Promise<T> {
  const method = call.method ?? 'GET';
  const url = new URL(`${GRAPH_HOST}/${config.facebook.graphVersion}/${call.path}`);
  const params = new URLSearchParams(call.params ?? {});
  if (method === 'GET') for (const [key, value] of params) url.searchParams.set(key, value);

  let res: Response;
  try {
    res = await rt.fetch(url.toString(), {
      method,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {
        ...(call.token ? { Authorization: `Bearer ${call.token}` } : {}),
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        accept: 'application/json',
      },
      body: method === 'POST' ? params.toString() : undefined,
    });
  } catch (err) {
    // A transport failure, not an answer: worth another attempt later.
    throw new Error(
      `the Facebook Graph call ${call.path} could not be made: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const error = (body as { error?: GraphErrorBody } | null)?.error ?? null;
  if (!res.ok || error) throw new GraphCallError(call.path, res.status, error, text);
  return (body ?? {}) as T;
}

/**
 * Meta's own wording for the monthly link cap is not published and its rollout
 * is a live test, so the rejection is recognised by what it says rather than by
 * a code: an error that names a link and a limit in one sentence. The local
 * counter is the primary guard - this is the correction for when the counter is
 * behind, which the scoping expects it sometimes to be.
 */
const LINK_QUOTA_HINT =
  /(?:link|url)[^.]{0,80}(?:limit|quota|cap|allowance|per month|this month|monthly)|(?:limit|quota|cap|allowance)[^.]{0,80}(?:link|url)/i;

function isLinkQuotaError(err: unknown): boolean {
  return err instanceof GraphCallError && LINK_QUOTA_HINT.test(err.detail);
}

/** Just the connection fields the failure mapping and the write-back need. */
interface ConnectionRef {
  id: string;
  tokenRef: string;
  status: ChannelStatus;
}

/**
 * The error the worker gets: actionable, never carrying the token, and
 * permanent only where repeating the call cannot change the answer.
 *
 * A rejected credential also leaves the rotation, because every later item
 * would otherwise spend all five of its attempts rediscovering the same thing.
 */
async function providerFailure(
  err: unknown,
  connection: ConnectionRef | null,
  token: string,
): Promise<Error> {
  if (!(err instanceof GraphCallError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  // Meta's own wording is quoted back to the operator, so it is scrubbed here
  // rather than trusted: this message ends up on a queue row a person reads.
  const detail = redactToken(err.detail, token);
  const secret = connection ? `the ${connection.tokenRef} secret` : 'the Page token secret';
  if (err.code !== null && TOKEN_CODES.has(err.code)) {
    if (connection?.status === 'active') await setConnectionStatus(connection.id, 'needs_reauth');
    return new PermanentProviderError(
      `Facebook rejected the Page access token (${detail}). Mint a new Page token with ` +
        `${REQUIRED_SCOPES}, then update ${secret}.`,
    );
  }
  if (err.code !== null && PERMISSION_CODES.has(err.code)) {
    return new PermanentProviderError(
      `Facebook refused the call because the Page token is not scoped for it (${detail}). ` +
        `Re-issue it with ${REQUIRED_SCOPES} and update ${secret}.`,
    );
  }
  return new Error(redactToken(err.message, token));
}

// ── The monthly body-link budget ────────────────────────────────────────────

/**
 * The month a post counts against. UTC, and the SQL below truncates in UTC too,
 * so the counter and the correction cannot disagree about which month it is on
 * a database whose session timezone is not UTC.
 */
function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * How many body links this Page has already spent this month.
 *
 * Derived from the queue rather than kept in a counter row: the posted rows are
 * the record of what actually went out, so a counter cannot drift away from
 * them, and a crash between the post and the increment cannot lose a unit. Two
 * workers posting at the same instant can still both read the last unit as
 * free - that is the case the API's own rejection corrects below, which is why
 * this is a guard rather than a lock.
 */
async function bodyLinksUsed(pageId: string): Promise<number> {
  const [row] = await q<{ used: number }>(
    `SELECT count(*)::int AS used
       FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
      WHERE item.provider = $1
        AND channel.external_account_id = $2
        AND item.placement = 'in_body'
        AND item.status = 'posted'
        AND item.posted_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [FACEBOOK_PROVIDER, pageId],
  );
  return row?.used ?? 0;
}

/**
 * This Page's body-link allowance for the month, as the panel shows it and as
 * the ladder checks it: spent once the count reaches the cap, or once Meta
 * itself refused a link this month, whichever came first.
 */
async function bodyLinkBudget(pageId: string, now: Date): Promise<LinkBudget> {
  const state = await getSetting<BudgetState>(BODY_LINK_BUDGET_SETTING, {});
  const used = await bodyLinksUsed(pageId);
  const cap = config.facebook.bodyLinkCap;
  return { used, cap, exhausted: state[pageId]?.month === monthKey(now) || used >= cap };
}

/** Whether a body link may still go out for this Page this month. */
async function bodyLinkAvailable(pageId: string, now: Date): Promise<boolean> {
  return !(await bodyLinkBudget(pageId, now)).exhausted;
}

/**
 * Remember that Meta itself said this Page is out of body links this month, so
 * the next item does not have to rediscover it by being rejected. Months other
 * than the current one are dropped on the way past: the row is a correction,
 * not a history.
 */
async function recordBudgetExhausted(pageId: string, now: Date): Promise<void> {
  const month = monthKey(now);
  const state = await getSetting<BudgetState>(BODY_LINK_BUDGET_SETTING, {});
  const next: BudgetState = {};
  for (const [page, entry] of Object.entries(state ?? {})) {
    if (entry?.month === month) next[page] = entry;
  }
  next[pageId] = { month, exhaustedAt: now.toISOString() };
  await setSetting(BODY_LINK_BUDGET_SETTING, next);
}

// ── What this adapter is allowed to post ────────────────────────────────────

/**
 * The payload an item ships, and the re-composition the ladder needs when the
 * placement it was rendered for turns out to be unaffordable.
 *
 * A port rather than a direct call so the flow can be driven without a copy
 * model, an image model or a bucket.
 */
export interface PayloadRenderer {
  /** Rendered on the first attempt, read back on every one after it. */
  forItem(item: DistributionItem): Promise<RenderedPayload>;
  /**
   * Re-compose this item for `placement` and keep the result on the row. The
   * placement of what comes back is not necessarily the one asked for: a post
   * with no image we may upload resolves back to 'in_body'. Null when there is
   * no article left to render from.
   */
  forPlacement(item: DistributionItem, placement: LinkPlacement): Promise<RenderedPayload | null>;
}

/** The article a queued item points at, in the shape the renderer reads. */
async function distributableArticle(item: DistributionItem): Promise<DistributableArticle | null> {
  if (!item.articleId) return null;
  const [row] = await q<DistributableArticle>(
    `SELECT id, slug, title, frontmatter, hero_image_url, hero_image_source, keyword_plan
       FROM articles WHERE id = $1`,
    [item.articleId],
  );
  return row ?? null;
}

/**
 * The real renderer. An article that has been deleted since the item was queued
 * leaves the baseline payload the publish stage wrote, which is still postable -
 * it just cannot be re-composed for another placement.
 */
const databaseRenderer: PayloadRenderer = {
  async forItem(item) {
    const article = await distributableArticle(item);
    return article ? renderForItem(item, article) : item.payload;
  },
  async forPlacement(item, placement) {
    const article = await distributableArticle(item);
    if (!article) return null;
    const payload = await render(article, FACEBOOK_PROVIDER, placement);
    await storeRenderedPayload(item.id, payload);
    return payload;
  },
};

// ── Token expiry, read back on every call ───────────────────────────────────

interface TokenInspection {
  /** False when Meta would not tell us, which is not the same as invalid. */
  known: boolean;
  valid: boolean;
  /** Seconds from now, or null for a token that does not expire. */
  expiresIn: number | null;
}

/**
 * What Meta says about this token.
 *
 * `debug_token` wants an app access token, and with FACEBOOK_APP_ID/SECRET set
 * that is exactly what it gets. Without them the token inspects itself, which
 * Meta answers for a token minted by an app the caller has a role on and
 * refuses otherwise. A refusal is not a failure: a Business Manager System User
 * Page token never expires at all, so "no expiry could be read" must never be
 * what stops a post going out.
 */
async function inspectToken(token: string, rt: Runtime): Promise<TokenInspection> {
  const { appId, appSecret } = config.facebook;
  const inspector = appId && appSecret ? `${appId}|${appSecret}` : token;
  try {
    const body = await graph<{ data?: { is_valid?: boolean; expires_at?: number } }>(
      { path: 'debug_token', params: { input_token: token }, token: inspector },
      rt,
    );
    const data = body.data ?? {};
    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0;
    return {
      known: true,
      valid: data.is_valid !== false,
      // 0 is Meta's "this one does not expire", which is `expires_at` NULL here.
      expiresIn: expiresAt > 0 ? Math.max(0, Math.round(expiresAt - rt.now().getTime() / 1000)) : null,
    };
  } catch (err) {
    log.info('facebook token expiry could not be read', {
      reason: redactToken(
        err instanceof GraphCallError ? err.detail : 'the debug_token call failed',
        token,
      ),
    });
    return { known: false, valid: true, expiresIn: null };
  }
}

/**
 * Move what Meta says about the token onto the connection, on every call that
 * uses it. A token Meta has stopped honouring sets the connection's status
 * rather than failing quietly somewhere an operator never looks.
 */
async function syncToken(connection: ConnectionRef | null, token: string, rt: Runtime): Promise<void> {
  if (!connection) return;
  const inspected = await inspectToken(token, rt);
  if (!inspected.known) return;
  if (!inspected.valid) {
    if (connection.status === 'active') await setConnectionStatus(connection.id, 'needs_reauth');
    throw new PermanentProviderError(
      `Facebook reports the Page access token as no longer valid. Mint a new Page token with ` +
        `${REQUIRED_SCOPES}, then update the ${connection.tokenRef} secret.`,
    );
  }
  // Only an active connection's expiry is written back: `recordTokenExpiry`
  // clears the status as well, and a connection an operator disabled must not
  // be put back in the rotation by a background insights read.
  if (connection.status === 'active') await recordTokenExpiry(connection.id, inspected.expiresIn);
}

function connectionOf(row: ChannelConnectionRow | null): ConnectionRef | null {
  return row ? { id: row.id, tokenRef: row.token_ref, status: row.status } : null;
}

// ── Posting ─────────────────────────────────────────────────────────────────

/** A created post, as /photos and /feed report it. */
interface CreatedPost {
  id: string;
  /** /photos returns the photo id as `id` and the Page post as `post_id`. */
  post_id?: string;
}

/**
 * The post itself: a native photo when there is an image we may upload, a plain
 * Page post when there is not.
 *
 * The second case only arises for an item whose article has been deleted, so
 * the renderer could not run its image ladder. A caption with its link in the
 * comment still reads correctly without the photo; what it must not do is carry
 * the link in the body, which is the budget this branch was sent here to save.
 */
async function createFirstCommentPost(
  payload: RenderedPayload,
  ctx: ProviderPostContext,
  rt: Runtime,
): Promise<CreatedPost> {
  const pageId = ctx.externalAccountId;
  if (payload.imageUrl) {
    return graph<CreatedPost>(
      {
        path: `${pageId}/photos`,
        method: 'POST',
        token: ctx.accessToken,
        params: { url: payload.imageUrl, caption: payload.caption, published: 'true' },
      },
      rt,
    );
  }
  return graph<CreatedPost>(
    {
      path: `${pageId}/feed`,
      method: 'POST',
      token: ctx.accessToken,
      params: { message: payload.caption },
    },
    rt,
  );
}

/**
 * Put the link up as the first comment. Returns null when it landed, or why it
 * did not - a permanent refusal (a missing scope, a rejected token) skips the
 * remaining attempts, because a permission does not appear on its own.
 */
async function postFirstComment(
  postId: string,
  message: string,
  ctx: ProviderPostContext,
  rt: Runtime,
): Promise<string | null> {
  let reason = 'no attempt was made';
  for (let attempt = 1; attempt <= COMMENT_ATTEMPTS; attempt++) {
    try {
      await graph(
        { path: `${postId}/comments`, method: 'POST', token: ctx.accessToken, params: { message } },
        rt,
      );
      return null;
    } catch (err) {
      const graphError = err instanceof GraphCallError ? err : null;
      reason = graphError?.detail ?? (err instanceof Error ? err.message : String(err));
      const code = graphError?.code ?? null;
      if (code !== null && (TOKEN_CODES.has(code) || PERMISSION_CODES.has(code))) {
        return `${reason} - the Page token needs ${REQUIRED_SCOPES}`;
      }
      if (attempt < COMMENT_ATTEMPTS) await rt.sleep(COMMENT_RETRY_MS * attempt);
    }
  }
  return reason;
}

/**
 * The first-comment flow: the post, then the link under it.
 *
 * Nothing after the post is created may throw. The post is live by then, and a
 * thrown error is a retry, and a retry is the same article on the Page twice -
 * so a comment that will not go up is answered with an edit that appends the
 * link to the caption, and an edit that will not go through is reported as a
 * degraded post an operator has to finish by hand.
 */
async function postWithFirstComment(
  payload: RenderedPayload,
  ctx: ProviderPostContext,
  connection: ConnectionRef | null,
  rt: Runtime,
): Promise<PostReceipt> {
  let created: CreatedPost;
  try {
    created = await createFirstCommentPost(payload, ctx, rt);
  } catch (err) {
    throw await providerFailure(err, connection, ctx.accessToken);
  }
  const remotePostId = created.post_id ?? created.id;

  const refusal = await postFirstComment(remotePostId, payload.commentText, ctx, rt);
  if (!refusal) return { remotePostId };
  // Quoted into the note the panel shows, so scrubbed before it goes anywhere.
  const failure = redactToken(refusal, ctx.accessToken);

  log.warn('facebook first comment failed; appending the link to the caption instead', {
    queue_item_id: ctx.item.id,
    slug: ctx.item.slug,
    remote_post_id: remotePostId,
    reason: failure,
  });
  try {
    await graph(
      {
        path: remotePostId,
        method: 'POST',
        token: ctx.accessToken,
        params: { message: `${payload.caption}\n\n${payload.url}` },
      },
      rt,
    );
    return {
      remotePostId,
      degraded: true,
      note: `the first comment failed (${failure}); the link was appended to the caption instead`,
    };
  } catch (err) {
    const detail = redactToken(
      err instanceof GraphCallError ? err.detail : String(err),
      ctx.accessToken,
    );
    return {
      remotePostId,
      degraded: true,
      note:
        `the first comment failed (${failure}) and appending the link to the caption failed ` +
        `(${detail}); the post is live with no link in it - add one by hand`,
    };
  }
}

/** The body-link flow: one link post, and Meta scrapes the card off our page. */
async function postLinkInBody(
  payload: RenderedPayload,
  ctx: ProviderPostContext,
  rt: Runtime,
): Promise<PostReceipt> {
  const created = await graph<CreatedPost>(
    {
      path: `${ctx.externalAccountId}/feed`,
      method: 'POST',
      token: ctx.accessToken,
      // `link` as well as the caption's own URL: the caption is what a reader
      // sees, the parameter is what Meta scrapes the Open Graph card from.
      params: { message: payload.caption, link: payload.url },
    },
    rt,
  );
  return { remotePostId: created.post_id ?? created.id };
}

/**
 * The bottom of the ladder: re-compose this post with the link in the first
 * comment, or park it for an operator.
 *
 * A hold rather than a failure because nothing is wrong that time will not fix
 * - next month's budget, or an operator dropping a hero in - and because the
 * alternative, a link post that Meta will reject, spends an attempt to learn
 * something we already know.
 */
async function toFirstComment(
  item: DistributionItem,
  requested: LinkPlacement,
  rt: Runtime,
): Promise<RenderedPayload> {
  const rerendered = await rt.renderer.forPlacement(item, 'first_comment');
  if (rerendered?.placement === 'first_comment') return rerendered;
  // Both are true by now - no image we may upload and no body link left - so
  // the reason is named after the one that took away what this item asked
  // for: a first-comment post lost its image, a body-link post its budget.
  throw new ProviderHoldError(
    'the Page has spent its body links for this month and this post has no image we may upload ' +
      'natively, so there is nowhere left to put the link - held rather than posted without one. ' +
      'Add a hero image to the article in the panel, or release this next month.',
    requested === 'first_comment' ? 'no_safe_image' : 'link_budget_exhausted',
  );
}

async function post(ctx: ProviderPostContext, rt: Runtime): Promise<PostReceipt> {
  const { item, externalAccountId: pageId } = ctx;
  const connection = connectionOf(await getConnection(item.channelConnectionId));
  await syncToken(connection, ctx.accessToken, rt);

  const requested = item.placement;
  let payload = await rt.renderer.forItem(item);

  // Checked before the call, not learned from it: a rejection here would cost
  // the item an attempt and teach us nothing the rows do not already say.
  if (payload.placement === 'in_body' && !(await bodyLinkAvailable(pageId, rt.now()))) {
    log.info('facebook body-link budget spent; placing this link in the first comment', {
      queue_item_id: item.id,
      slug: item.slug,
      cap: config.facebook.bodyLinkCap,
    });
    payload = await toFirstComment(item, requested, rt);
  }

  if (payload.placement === 'first_comment') {
    return postWithFirstComment(payload, ctx, connection, rt);
  }

  try {
    return await postLinkInBody(payload, ctx, rt);
  } catch (err) {
    if (!isLinkQuotaError(err)) throw await providerFailure(err, connection, ctx.accessToken);
    // Meta's own verdict beats the local count, and corrects it: the cap's
    // rollout is a test, so the count can be behind what the Page is actually
    // allowed. Nothing has been posted yet, so this costs a re-composition
    // rather than the post.
    await recordBudgetExhausted(pageId, rt.now());
    log.warn('facebook refused a body link for the monthly cap; the local count was behind', {
      queue_item_id: item.id,
      slug: item.slug,
      reason: redactToken(err instanceof GraphCallError ? err.detail : String(err), ctx.accessToken),
    });
    return postWithFirstComment(await toFirstComment(item, requested, rt), ctx, connection, rt);
  }
}

// ── Insights ────────────────────────────────────────────────────────────────

interface InsightRow {
  name?: string;
  values?: Array<{ value?: unknown }>;
}

/**
 * One metric as a number. `post_reactions_by_type_total` answers with a map of
 * reaction type to count, which is summed - the breakdown is more than we asked
 * for and more than we keep.
 */
function insightValue(rows: InsightRow[], metric: string): number | null {
  const value = rows.find((row) => row.name === metric)?.values?.[0]?.value;
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, count) => total + (typeof count === 'number' ? count : 0),
      0,
    );
  }
  return null;
}

async function fetchInsights(ctx: ProviderInsightsContext, rt: Runtime): Promise<InsightSnapshot> {
  const connection = connectionOf(await findConnection(FACEBOOK_PROVIDER, ctx.externalAccountId));
  await syncToken(connection, ctx.accessToken, rt);

  let body: { data?: InsightRow[] };
  try {
    body = await graph<{ data?: InsightRow[] }>(
      {
        path: `${ctx.remotePostId}/insights`,
        token: ctx.accessToken,
        params: { metric: INSIGHT_METRICS.join(',') },
      },
      rt,
    );
  } catch (err) {
    throw await providerFailure(err, connection, ctx.accessToken);
  }
  const rows = body.data ?? [];
  return {
    impressions: insightValue(rows, 'post_impressions'),
    clicks: insightValue(rows, 'post_clicks'),
    reactions: insightValue(rows, 'post_reactions_by_type_total'),
    fetchedAt: rt.now().toISOString(),
  };
}

// ── Connecting a Page ───────────────────────────────────────────────────────

interface ResolvedPage {
  id: string;
  name: string;
  accessToken: string;
}

/**
 * The Page this token posts as.
 *
 * A Page token identifies a Page, and `/me` returns it with a category. A User
 * or System User token returns a person instead, which Graph signals by
 * refusing the `category` field - and in that case the Page token is one hop
 * away on `/me/accounts`, which is the hop an operator most often forgets.
 */
async function resolvePage(token: string, rt: Runtime): Promise<ResolvedPage> {
  try {
    const me = await graph<{ id: string; name?: string; category?: string }>(
      { path: 'me', params: { fields: 'id,name,category' }, token },
      rt,
    );
    if (me.category) return { id: me.id, name: me.name ?? me.id, accessToken: token };
  } catch (err) {
    if (!(err instanceof GraphCallError) || err.code !== 100) {
      throw await providerFailure(err, null, token);
    }
  }

  let accounts: { data?: Array<{ id: string; name?: string; access_token?: string }> };
  try {
    accounts = await graph({ path: 'me/accounts', params: { fields: 'id,name,access_token' }, token }, rt);
  } catch (err) {
    throw await providerFailure(err, null, token);
  }
  const pages = accounts.data ?? [];
  if (pages.length === 1) {
    return {
      id: pages[0].id,
      name: pages[0].name ?? pages[0].id,
      accessToken: pages[0].access_token ?? token,
    };
  }
  throw new PermanentProviderError(
    pages.length === 0
      ? `that token administers no Facebook Page. Use a Page access token for the Page you ` +
        `administer, scoped for ${REQUIRED_SCOPES}.`
      : `that token administers ${pages.length} Pages (${pages
          .map((page) => page.name ?? page.id)
          .join(', ')}). Paste the access token of the one Page to post as, not the user token.`,
  );
}

/**
 * Connect a Page from a token an operator pasted.
 *
 * There is no OAuth code exchange here on purpose: the whole point of this
 * adapter is to post without App Review or Business Verification, which means
 * Standard Access on a Page the operator already administers and a token they
 * mint themselves.
 */
async function authenticate(params: AuthenticateParams, rt: Runtime): Promise<AuthTokenDetails> {
  const token = params.token?.trim();
  if (!token) {
    throw new PermanentProviderError(
      'connecting a Facebook Page takes a Page access token, not an OAuth code: mint one in ' +
        `Graph API Explorer or for a Business Manager System User, scoped for ${REQUIRED_SCOPES}.`,
    );
  }
  const page = await resolvePage(token, rt);
  return {
    externalAccountId: page.id,
    displayName: page.name,
    accessToken: page.accessToken,
    expiresIn: (await inspectToken(page.accessToken, rt)).expiresIn,
  };
}

/**
 * A Page access token has no refresh grant. With app credentials configured a
 * short-lived token is exchanged for a long-lived one; without them the only
 * honest refresh is to re-read the token we have - which is the right answer
 * for the System User token this is meant to run on, because that one does not
 * expire.
 */
async function refreshToken(token: string, rt: Runtime): Promise<AuthTokenDetails> {
  const { appId, appSecret } = config.facebook;
  let refreshed = token;
  if (appId && appSecret) {
    try {
      const exchanged = await graph<{ access_token?: string }>(
        {
          path: 'oauth/access_token',
          token: null,
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: token,
          },
        },
        rt,
      );
      if (exchanged.access_token) refreshed = exchanged.access_token;
    } catch (err) {
      throw await providerFailure(err, null, token);
    }
  }
  const page = await resolvePage(refreshed, rt);
  return {
    externalAccountId: page.id,
    displayName: page.name,
    accessToken: page.accessToken,
    expiresIn: (await inspectToken(page.accessToken, rt)).expiresIn,
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** Everything the adapter touches that a test needs to stand in for. */
export interface FacebookDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  renderer?: PayloadRenderer;
}

interface Runtime {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  renderer: PayloadRenderer;
}

export function createFacebookProvider(deps: FacebookDeps = {}): SocialProvider {
  const rt: Runtime = {
    fetch: deps.fetch ?? globalThis.fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => new Date()),
    renderer: deps.renderer ?? databaseRenderer,
  };
  return {
    name: FACEBOOK_PROVIDER,
    authenticate: (params) => authenticate(params, rt),
    refreshToken: (token) => refreshToken(token, rt),
    post: (ctx) => post(ctx, rt),
    fetchInsights: (ctx) => fetchInsights(ctx, rt),
    // The secret name the root README tells an operator to create.
    defaultTokenRef: 'facebook-page-token',
    // A Page post id is `{page}_{post}`, which facebook.com resolves directly.
    postUrl: (remotePostId) => `https://www.facebook.com/${encodeURIComponent(remotePostId)}`,
    linkBudget: (pageId) => bodyLinkBudget(pageId, rt.now()),
  };
}

/** The adapter the platform registers at boot. */
export const facebookProvider = createFacebookProvider();
