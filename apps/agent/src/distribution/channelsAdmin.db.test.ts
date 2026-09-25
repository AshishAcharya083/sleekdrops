// The admin Channels screen's API, driven through the Hono app the panel calls:
// same verbs, same bearer header, same JSON bodies. What it proves is the part
// the panel cannot check for itself - that a pasted token is never echoed, that
// the queue filters agree with the chip counts, and that the manual moves only
// ever apply to the state they are named for.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SITE_URL = 'https://sleekdrops.com';

const { pool, q, getSetting, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { enqueuePublishedArticle, getItem } = await import('./queue.js');
const { registerProvider, unregisterProvider } = await import('./providers.js');
const { processItem } = await import('./worker.js');
const { PermanentProviderError, ProviderHoldError } = await import('./types.js');

import type {
  AuthTokenDetails,
  DistributableArticle,
  DistributionItem,
  DistributionQueueRow,
  SocialProvider,
} from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

const articles: string[] = [];
const connections: string[] = [];
const registered: string[] = [];
const refs: string[] = [];

after(async () => {
  for (const name of registered) unregisterProvider(name);
  if (reachable) {
    await q(
      `DELETE FROM channel_connections WHERE id = ANY($1)
          OR provider = ANY($2)`,
      [connections, registered],
    );
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
    const stored = await getSetting<Record<string, string>>('channel_credentials', {});
    for (const ref of refs) delete stored[ref];
    await setSetting('channel_credentials', stored);
    for (const name of registered) await q('DELETE FROM settings WHERE key = $1', [`${name}_link_placement`]);
  }
  await pool.end();
});

/**
 * A network whose authenticate answers from a table of tokens: each pasted
 * token posts as the account it maps to and is exchanged for a derived account
 * token, the way a Facebook user token becomes a Page token.
 */
function stubNetwork(
  accounts: Record<string, { id: string; name: string; expiresIn: number | null }>,
  extra: Partial<SocialProvider> = {},
): string {
  const name = `stub-channels-${randomUUID().slice(0, 8)}`;
  const provider: SocialProvider = {
    name,
    defaultTokenRef: `${name}-page-token`,
    async authenticate({ token }): Promise<AuthTokenDetails> {
      const account = token ? accounts[token] : undefined;
      if (!account) {
        // Quoting the token back is exactly what a careless network error
        // does, and exactly what the API must scrub.
        throw new PermanentProviderError(`the token ${token} was rejected: code 190`);
      }
      return {
        externalAccountId: account.id,
        displayName: account.name,
        accessToken: `exchanged-${token}`,
        expiresIn: account.expiresIn,
      };
    },
    refreshToken: async () => {
      throw new Error('not used here');
    },
    post: async () => {
      throw new Error('not used here');
    },
    fetchInsights: async () => ({
      impressions: null,
      clicks: null,
      reactions: null,
      fetchedAt: new Date().toISOString(),
    }),
    postUrl: (remotePostId) => `https://social.example/${remotePostId}`,
    ...extra,
  };
  registerProvider(provider);
  registered.push(name);
  refs.push(`${name}-page-token`);
  return name;
}

interface ChannelView {
  id: string;
  provider: string;
  externalAccountId: string;
  displayName: string | null;
  tokenRef: string;
  status: string;
  tokenTier: string;
  credential: { stored: boolean; source: string | null };
  placement: { value: string; setting: string };
  counts: Record<string, number>;
}

async function connectVia(body: Record<string, unknown>): Promise<Response> {
  return app.request('/api/distribution/channels', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify(body),
  });
}

async function channelsList(): Promise<ChannelView[]> {
  const res = await app.request('/api/distribution', { headers: AUTH });
  assert.equal(res.status, 200);
  return ((await res.json()) as { channels: ChannelView[] }).channels;
}

// ── Connect, replace, disconnect ───────────────────────────────────────────

test('connecting stores the credential by reference and never echoes it', { skip }, async () => {
  const pasted = `pasted-user-token-${randomUUID()}`;
  const account = `page-${randomUUID().slice(0, 8)}`;
  const provider = stubNetwork({
    [pasted]: { id: account, name: 'SleekDrops', expiresIn: 20 * 86_400 },
  });

  const res = await connectVia({ provider, token: pasted });
  assert.equal(res.status, 201);
  const raw = await res.text();
  assert.ok(!raw.includes(pasted), 'the pasted token is never sent back');
  assert.ok(!raw.includes(`exchanged-${pasted}`), 'nor the token the network exchanged it for');

  const { channel } = JSON.parse(raw) as { channel: ChannelView };
  connections.push(channel.id);
  assert.equal(channel.provider, provider);
  assert.equal(channel.externalAccountId, account);
  assert.equal(channel.displayName, 'SleekDrops');
  assert.equal(channel.status, 'active');
  assert.equal(channel.tokenRef, `${provider}-page-token`, "the adapter's documented secret name");
  assert.deepEqual(channel.credential, { stored: true, source: 'panel' });
  assert.equal(channel.tokenTier, 'notice', '20 days out is the calm 30-day rung');

  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  assert.equal(stored[channel.tokenRef], `exchanged-${pasted}`, 'the account token is what posts');

  for (const path of ['/api/distribution', '/api/settings']) {
    const polled = await (await app.request(path, { headers: AUTH })).text();
    assert.ok(!polled.includes(pasted) && !polled.includes(`exchanged-${pasted}`), path);
  }
});

test('a rejected token is refused with the reason, scrubbed of the token', { skip }, async () => {
  const provider = stubNetwork({});
  const pasted = `not-a-real-token-${randomUUID()}`;
  const res = await connectVia({ provider, token: pasted });
  assert.equal(res.status, 400);
  const raw = await res.text();
  assert.ok(!raw.includes(pasted), 'the refusal does not quote the token');
  assert.match(raw, /rejected: code 190/, "the network's own reason survives");
  const [row] = await q<{ n: number }>(
    'SELECT count(*)::int n FROM channel_connections WHERE provider = $1',
    [provider],
  );
  assert.equal(row.n, 0, 'nothing is connected on a refusal');
});

test('connect refuses a network with no adapter and a request with no credential', { skip }, async () => {
  const unknown = await connectVia({ provider: 'myspace', token: 'x'.repeat(20) });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'no adapter is installed for myspace' });

  const provider = stubNetwork({});
  const empty = await connectVia({ provider });
  assert.equal(empty.status, 400);

  const badRef = await connectVia({ provider, token: 'abc', tokenRef: '../etc/passwd' });
  assert.equal(badRef.status, 400);
});

test('a mounted secret connects by name without the panel storing a copy', { skip }, async () => {
  const token = `mounted-token-${randomUUID()}`;
  const account = `page-${randomUUID().slice(0, 8)}`;
  const provider = stubNetwork(
    { [token]: { id: account, name: 'Mounted', expiresIn: null } },
    {
      // A token that is already the account's own comes back unchanged.
      async authenticate({ token: given }) {
        if (given !== token) throw new PermanentProviderError('rejected');
        return { externalAccountId: account, displayName: 'Mounted', accessToken: given, expiresIn: null };
      },
    },
  );
  const ref = `${provider}-mounted`;
  process.env[ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')] = token;

  const res = await connectVia({ provider, tokenRef: ref });
  assert.equal(res.status, 201);
  const { channel } = (await res.json()) as { channel: ChannelView };
  connections.push(channel.id);
  assert.equal(channel.tokenRef, ref);
  assert.deepEqual(channel.credential, { stored: true, source: 'environment' });
  assert.equal(channel.tokenTier, 'ok', 'a token that never expires needs no warning');
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  assert.equal(ref in stored, false, 'nothing was copied out of the secret store');
});

test('replacing a credential keeps the account, and refuses a different one', { skip }, async () => {
  const first = `first-${randomUUID()}`;
  const rotated = `rotated-${randomUUID()}`;
  const stranger = `stranger-${randomUUID()}`;
  const account = `page-${randomUUID().slice(0, 8)}`;
  const provider = stubNetwork({
    [first]: { id: account, name: 'SleekDrops', expiresIn: 3 * 86_400 },
    [rotated]: { id: account, name: 'SleekDrops AU', expiresIn: 60 * 86_400 },
    [stranger]: { id: 'someone-else', name: 'Other Page', expiresIn: null },
  });
  const { channel } = (await (await connectVia({ provider, token: first })).json()) as {
    channel: ChannelView;
  };
  connections.push(channel.id);
  assert.equal(channel.tokenTier, 'warning', 'three days out is the amber week');
  await q(`UPDATE channel_connections SET status = 'needs_reauth' WHERE id = $1`, [channel.id]);

  const wrong = await app.request(`/api/distribution/channels/${channel.id}/credential`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ token: stranger }),
  });
  assert.equal(wrong.status, 409);
  assert.ok(!(await wrong.text()).includes(stranger));

  const res = await app.request(`/api/distribution/channels/${channel.id}/credential`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ token: rotated }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(rotated));
  const replaced = (JSON.parse(raw) as { channel: ChannelView }).channel;
  assert.equal(replaced.status, 'active', 'a working token takes the channel out of needs_reauth');
  assert.equal(replaced.tokenTier, 'ok');
  assert.equal(replaced.displayName, 'SleekDrops AU');
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  assert.equal(stored[channel.tokenRef], `exchanged-${rotated}`);
});

test('disconnecting disables the channel, keeps its history and forgets the token', { skip }, async () => {
  const pasted = `pasted-${randomUUID()}`;
  const provider = stubNetwork({
    [pasted]: { id: `page-${randomUUID().slice(0, 8)}`, name: 'SleekDrops', expiresIn: null },
  });
  const { channel } = (await (await connectVia({ provider, token: pasted })).json()) as {
    channel: ChannelView;
  };
  connections.push(channel.id);
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const res = await app.request(`/api/distribution/channels/${channel.id}`, {
    method: 'DELETE',
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    channel: ChannelView;
    credentialRemoved: boolean;
    environmentSecret: boolean;
  };
  assert.equal(body.channel.status, 'disabled');
  assert.equal(body.credentialRemoved, true);
  assert.equal(body.environmentSecret, false);
  assert.deepEqual(body.channel.credential, { stored: false, source: null });
  assert.equal(body.channel.counts.all, 1, 'the queue row survives the disconnect');

  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  assert.equal(channel.tokenRef in stored, false);

  // Reconnecting pastes a token through the replace route, which only accepts
  // the same account and brings the channel back into the rotation.
  const back = await app.request(`/api/distribution/channels/${channel.id}/credential`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ token: pasted }),
  });
  assert.equal(back.status, 200);
  const reconnected = ((await back.json()) as { channel: ChannelView }).channel;
  assert.equal(reconnected.status, 'active');
  assert.deepEqual(reconnected.credential, { stored: true, source: 'panel' });

  const missing = await app.request(`/api/distribution/channels/${randomUUID()}`, {
    method: 'DELETE',
    headers: AUTH,
  });
  assert.equal(missing.status, 404);
});

test('the channel routes are behind the admin bearer', { skip }, async () => {
  for (const [method, path] of [
    ['POST', '/api/distribution/channels'],
    ['POST', '/api/distribution/items/bulk'],
    ['GET', `/api/distribution/channels/${randomUUID()}/queue`],
  ]) {
    const res = await app.request(path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

// ── The queue ──────────────────────────────────────────────────────────────

async function article(): Promise<DistributableArticle> {
  const frontmatter = { title: 'A quiet commute', dek: 'Ranked.', heroImage: 'https://x/y.png' };
  const [row] = await q<{ id: string; slug: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter,
                           hero_image_source)
     VALUES ('A quiet commute', $1, 'Tech', 'guide', 'publish', 'queued', $2::jsonb, 'generated')
     RETURNING id, slug`,
    [`channels-admin-${randomUUID().slice(0, 8)}`, JSON.stringify(frontmatter)],
  );
  articles.push(row.id);
  return {
    id: row.id,
    slug: row.slug,
    title: 'A quiet commute',
    frontmatter,
    hero_image_url: null,
    hero_image_source: 'generated',
  };
}

/** A channel with one item in every state the panel distinguishes. */
async function populatedChannel(): Promise<{
  channelId: string;
  provider: string;
  ids: Record<'pending' | 'gate' | 'held' | 'failed' | 'posted', string>;
}> {
  const provider = stubNetwork({});
  const [connection] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, 'stub-channels-ref') RETURNING id`,
    [provider, `page-${randomUUID().slice(0, 8)}`],
  );
  connections.push(connection.id);
  const ids = {} as Record<'pending' | 'gate' | 'held' | 'failed' | 'posted', string>;
  for (const state of ['pending', 'gate', 'held', 'failed', 'posted'] as const) {
    const piece = await article();
    await enqueuePublishedArticle(piece, { d1Status: 'published' });
    const [row] = await q<{ id: string }>(
      'SELECT id FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
      [piece.slug, connection.id],
    );
    ids[state] = row.id;
  }
  await q(`UPDATE distribution_queue SET readiness_started_at = now(),
             last_error = 'waiting for the site: HTTP 404' WHERE id = $1`, [ids.gate]);
  await q(`UPDATE distribution_queue SET status = 'held', attempts = 1, hold_reason = 'no_safe_image',
             last_error = 'no image we may upload' WHERE id = $1`, [ids.held]);
  await q(`UPDATE distribution_queue SET status = 'failed', attempts = 5,
             readiness_started_at = now(), last_error = 'HTTP 500 (5 attempt(s), giving up)'
           WHERE id = $1`, [ids.failed]);
  await q(`UPDATE distribution_queue SET status = 'posted', attempts = 1, remote_post_id = 'p_1',
             posted_at = now() WHERE id = $1`, [ids.posted]);
  return { channelId: connection.id, provider, ids };
}

interface QueueRow {
  id: string;
  status: string;
  holdReason: string | null;
  title: string | null;
  remoteUrl: string | null;
  attempts: number;
  lastError: string | null;
  placement: string;
}

async function queueOf(channelId: string, status: string): Promise<QueueRow[]> {
  const res = await app.request(`/api/distribution/channels/${channelId}/queue?status=${status}`, {
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { items: QueueRow[] }).items;
}

test('the queue filters agree with the chip counts and say why an item waits', { skip }, async () => {
  const { channelId, ids } = await populatedChannel();

  const held = await queueOf(channelId, 'held');
  assert.deepEqual(held.map((item) => item.id).sort(), [ids.gate, ids.held].sort());
  assert.equal(held.find((item) => item.id === ids.held)?.holdReason, 'no_safe_image');
  assert.equal(
    held.find((item) => item.id === ids.gate)?.holdReason,
    'site_not_ready',
    'a pending item at the readiness gate reads as waiting on the site',
  );

  assert.deepEqual((await queueOf(channelId, 'pending')).map((item) => item.id), [ids.pending]);
  assert.deepEqual((await queueOf(channelId, 'failed')).map((item) => item.id), [ids.failed]);
  const posted = await queueOf(channelId, 'posted');
  assert.equal(posted[0].remoteUrl, 'https://social.example/p_1', "the adapter's own post link");
  assert.equal(posted[0].title, 'A quiet commute');

  const all = await queueOf(channelId, 'all');
  assert.equal(all.length, 5);
  assert.deepEqual(
    all.slice(0, 2).map((item) => item.status).sort(),
    ['failed', 'held'],
    'what waits on a person comes first',
  );

  const mine = (await channelsList()).find((channel) => channel.id === channelId)!;
  assert.deepEqual(mine.counts, { all: 5, pending: 1, held: 2, failed: 1, posted: 1 });

  const bad = await app.request(`/api/distribution/channels/${channelId}/queue?status=stuck`, {
    headers: AUTH,
  });
  assert.equal(bad.status, 400);
  const gone = await app.request(`/api/distribution/channels/${randomUUID()}/queue`, {
    headers: AUTH,
  });
  assert.equal(gone.status, 404);
});

test('retry applies to a failed item only, with a fresh round of attempts', { skip }, async () => {
  const { ids } = await populatedChannel();

  const refused = await app.request(`/api/distribution/items/${ids.held}/retry`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: 'only a failed item can be retried - this one is held',
  });

  const res = await app.request(`/api/distribution/items/${ids.failed}/retry`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  const retried = (await getItem(ids.failed))!;
  assert.equal(retried.status, 'pending');
  assert.equal(retried.attempts, 0, 'five spent attempts would fail it again on the first call');
  assert.equal(retried.readinessStartedAt, null, 'a fresh readiness window');
  assert.match(retried.lastError ?? '', /giving up/, 'what went wrong last time stays visible');
  assert.ok(new Date(retried.scheduledAt).getTime() <= Date.now() + 1000, 'due now');

  const missing = await app.request(`/api/distribution/items/${randomUUID()}/retry`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(missing.status, 404);
});

test('release applies to a held item only, and clears its reason', { skip }, async () => {
  const { ids } = await populatedChannel();

  const gate = await app.request(`/api/distribution/items/${ids.gate}/release`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(gate.status, 409, 'an item at the readiness gate retries by itself');

  const res = await app.request(`/api/distribution/items/${ids.held}/release`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  const [row] = await q<DistributionQueueRow>('SELECT * FROM distribution_queue WHERE id = $1', [
    ids.held,
  ]);
  assert.equal(row.status, 'pending');
  assert.equal(row.hold_reason, null);
  assert.equal(row.attempts, 0);
});

test('the bulk bar moves the eligible items and reports the rest', { skip }, async () => {
  const { ids } = await populatedChannel();
  const second = await populatedChannel();
  const bulk = (action: string, selected: string[]) =>
    app.request('/api/distribution/items/bulk', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ action, ids: selected }),
    });

  const retry = await bulk('retry', [ids.failed, second.ids.failed, ids.held, 'not-an-id']);
  assert.equal(retry.status, 200);
  const retried = (await retry.json()) as { updated: string[]; skipped: string[] };
  assert.deepEqual(retried.updated.sort(), [ids.failed, second.ids.failed].sort());
  assert.deepEqual(retried.skipped.sort(), [ids.held, 'not-an-id'].sort());

  const release = await bulk('release', [ids.held, second.ids.held, ids.gate]);
  const released = (await release.json()) as { updated: string[]; skipped: string[] };
  assert.deepEqual(released.updated.sort(), [ids.held, second.ids.held].sort());
  assert.deepEqual(released.skipped, [ids.gate]);

  assert.equal((await bulk('delete', [ids.posted])).status, 400);
  assert.equal((await bulk('retry', [])).status, 400);
});

test('a placement override re-composes the post for the new placement', { skip }, async () => {
  const { ids } = await populatedChannel();
  // As if the renderer had already composed this item for a first comment.
  await q(
    `UPDATE distribution_queue
        SET payload = payload || '{"renderedAt": "2026-09-01T00:00:00Z", "caption": "composed"}'::jsonb
      WHERE id = $1`,
    [ids.held],
  );
  const res = await app.request(`/api/distribution/items/${ids.held}/placement`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ placement: 'in_body' }),
  });
  assert.equal(res.status, 200);
  const { item } = (await res.json()) as { item: DistributionItem };
  assert.equal(item.placement, 'in_body');
  assert.equal(item.payload.placement, 'in_body');
  assert.equal(item.payload.renderedAt, undefined, 'the next attempt composes it afresh');
  assert.match(item.payload.url, /utm_content=in_body/);
  assert.equal(item.status, 'held', 'a held item still waits for its release');

  const posted = await app.request(`/api/distribution/items/${ids.posted}/placement`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ placement: 'in_body' }),
  });
  assert.equal(posted.status, 409);
  assert.deepEqual(await posted.json(), { error: 'this item has already been posted' });

  const invalid = await app.request(`/api/distribution/items/${ids.pending}/placement`, {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ placement: 'in_the_bio' }),
  });
  assert.equal(invalid.status, 400);
});

test('the queue drawer reads one item with its insights', { skip }, async () => {
  const { ids } = await populatedChannel();
  await q(
    `INSERT INTO distribution_metrics (queue_item_id, impressions, clicks, reactions)
     VALUES ($1, 120, 4, NULL)`,
    [ids.posted],
  );
  const res = await app.request(`/api/distribution/items/${ids.posted}`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    item: QueueRow;
    metrics: Array<{ impressions: number | null; clicks: number | null; reactions: number | null }>;
  };
  assert.equal(body.item.id, ids.posted);
  assert.deepEqual(
    body.metrics.map(({ impressions, clicks, reactions }) => ({ impressions, clicks, reactions })),
    [{ impressions: 120, clicks: 4, reactions: null }],
  );
  const missing = await app.request(`/api/distribution/items/${randomUUID()}`, { headers: AUTH });
  assert.equal(missing.status, 404);
});

// ── The placement setting ──────────────────────────────────────────────────

test("a network's own placement setting is writable and wins at enqueue", { skip }, async () => {
  const { provider, channelId } = await populatedChannel();
  const key = `${provider}_link_placement`;

  const refused = await app.request('/api/settings', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ [key]: 'in_the_bio' }),
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: `${key} must be first_comment | in_body` });

  const saved = await app.request('/api/settings', {
    method: 'PUT',
    headers: JSON_AUTH,
    body: JSON.stringify({ [key]: 'in_body', nobody_link_placement: 'in_body' }),
  });
  assert.equal(saved.status, 200);
  const settings = (await saved.json()) as Record<string, unknown>;
  assert.equal(settings[key], 'in_body');
  assert.equal('nobody_link_placement' in settings, false, 'a network nobody runs is not a setting');

  const mine = (await channelsList()).find((channel) => channel.id === channelId)!;
  assert.deepEqual(mine.placement, { value: 'in_body', setting: key });

  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });
  const [row] = await q<{ placement: string }>(
    'SELECT placement FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [piece.slug, channelId],
  );
  assert.equal(row.placement, 'in_body');
});

test('the Facebook placement is seeded as a setting the panel reads', { skip }, async () => {
  const res = await app.request('/api/settings', { headers: AUTH });
  const settings = (await res.json()) as Record<string, unknown>;
  assert.ok(
    settings.facebook_link_placement === 'first_comment' || settings.facebook_link_placement === 'in_body',
  );
});

// ── The hold reason, through the worker ────────────────────────────────────

test('a provider hold writes its reason onto the row', { skip }, async () => {
  const token = `hold-token-${randomUUID()}`;
  const provider = stubNetwork(
    {},
    {
      post: async () => {
        throw new ProviderHoldError(`no budget left (token ${token})`, 'link_budget_exhausted');
      },
    },
  );
  const ref = `${provider}-hold`;
  refs.push(ref);
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  await setSetting('channel_credentials', { ...stored, [ref]: token });
  const [connection] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, $3) RETURNING id`,
    [provider, `page-${randomUUID().slice(0, 8)}`, ref],
  );
  connections.push(connection.id);
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });
  const [row] = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [piece.slug, connection.id],
  );
  const { toDistributionItem } = await import('./types.js');

  const outcome = await processItem(toDistributionItem(row), {
    fetchPage: async () => ({
      status: 200,
      body: `<meta property="og:title" content="A quiet commute | SleekDrops" />
             <meta property="og:image" content="https://x/y.png" />`,
    }),
  });
  assert.equal(outcome, 'held');
  const held = (await getItem(row.id))!;
  assert.equal(held.status, 'held');
  assert.equal(held.holdReason, 'link_budget_exhausted');
  assert.ok(!(held.lastError ?? '').includes(token), 'the hold message is scrubbed like an error');
});
