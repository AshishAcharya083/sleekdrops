// The admin API's view of distribution, driven through the Hono app the panel
// actually calls: same verb, same bearer header, same JSON.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { getSetting, setSetting } = await import('../db/pool.js');
const { enqueuePublishedArticle } = await import('./queue.js');
const { TOKEN_STALE_WINDOW_MS } = await import('./channels.js');

import type { DistributableArticle } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
const PROVIDER = `stub-admin-${randomUUID().slice(0, 8)}`;
const SECRET_VALUE = 'a-page-token-nobody-should-see';
process.env.STUB_ADMIN_TOKEN_REF = SECRET_VALUE;

const articles: string[] = [];
const connections: string[] = [];

after(async () => {
  if (reachable) {
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

interface ChannelView {
  id: string;
  provider: string;
  tokenRef: string;
  status: string;
  adapterInstalled: boolean;
  token: { expired: boolean; stale: boolean; hoursRemaining: number | null };
}

async function connect(expiresAt: string | null): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref, expires_at)
     VALUES ($1, $2, 'stub-admin-token-ref', $3) RETURNING id`,
    [PROVIDER, `page-${randomUUID().slice(0, 8)}`, expiresAt],
  );
  connections.push(row.id);
  return row.id;
}

async function article(): Promise<DistributableArticle> {
  const frontmatter = { title: 'A quiet commute', dek: 'Ranked.', heroImage: 'https://x/y.png' };
  const [row] = await q<{ id: string; slug: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter,
                           hero_image_source)
     VALUES ('A quiet commute', $1, 'Tech', 'guide', 'publish', 'queued', $2::jsonb, 'generated')
     RETURNING id, slug`,
    [`admin-view-${randomUUID().slice(0, 8)}`, JSON.stringify(frontmatter)],
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

test('the panel reads channel staleness and the queue, never a token', { skip }, async () => {
  const soon = new Date(Date.now() + TOKEN_STALE_WINDOW_MS / 2).toISOString();
  const connection = await connect(soon);
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const res = await app.request('/api/distribution', { headers: AUTH });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes(SECRET_VALUE), 'the value behind a token_ref is never serialised');

  const body = JSON.parse(raw) as {
    channels: ChannelView[];
    providers: string[];
    counts: Record<string, number>;
    items: Array<{ slug: string; provider: string; status: string }>;
  };
  const mine = body.channels.find((channel) => channel.id === connection)!;
  assert.equal(mine.provider, PROVIDER);
  assert.equal(mine.tokenRef, 'stub-admin-token-ref', 'the reference, so an operator knows what to rotate');
  assert.equal(mine.token.expired, false);
  assert.equal(mine.token.stale, true, 'a token inside the warning window says so before it lapses');
  assert.equal(
    mine.adapterInstalled,
    false,
    'a connection whose adapter has not shipped is visible rather than silently idle',
  );
  assert.ok(body.counts.pending >= 1);
  assert.ok(body.items.some((item) => item.slug === piece.slug && item.status === 'pending'));
});

test('an expired token is reported as expired', { skip }, async () => {
  const connection = await connect(new Date(Date.now() - 86_400_000).toISOString());
  const res = await app.request('/api/distribution', { headers: AUTH });
  const body = (await res.json()) as { channels: ChannelView[] };
  const mine = body.channels.find((channel) => channel.id === connection)!;
  assert.equal(mine.token.expired, true);
  assert.equal(mine.token.hoursRemaining! <= -24, true);
});

test('distribution is behind the admin bearer like everything else', { skip }, async () => {
  const res = await app.request('/api/distribution');
  assert.equal(res.status, 401);
});

test('an article carries its own distribution queue', { skip }, async () => {
  const connection = await connect(null);
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const res = await app.request(`/api/articles/${piece.id}`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    distribution: Array<{
      slug: string;
      provider: string;
      status: string;
      attempts: number;
      channelConnectionId: string;
    }>;
  };
  // One row per connection this file has opened, and every one of them is for
  // this article - so the assertion names the connection rather than counting.
  const mine = body.distribution.filter((item) => item.channelConnectionId === connection);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].slug, piece.slug);
  assert.equal(mine[0].provider, PROVIDER);
  assert.equal(mine[0].status, 'pending');
  assert.equal(mine[0].attempts, 0);
});

test('the settings the panel polls never carry a channel credential', { skip }, async () => {
  const stored = await getSetting<Record<string, string>>('channel_credentials', {});
  await setSetting('channel_credentials', { ...stored, 'stub-admin-token-ref': SECRET_VALUE });
  try {
    const res = await app.request('/api/settings', { headers: AUTH });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(SECRET_VALUE), '/api/settings is polled by a browser');
    assert.equal('channel_credentials' in (JSON.parse(raw) as Record<string, unknown>), false);
  } finally {
    await setSetting('channel_credentials', stored);
  }
});

test('a placement the providers do not implement is refused', { skip }, async () => {
  const res = await app.request('/api/settings', {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    // Only the bad key: a rejected PUT must write nothing, and this database is
    // shared with every other suite running right now.
    body: JSON.stringify({ distribution_link_placement: 'in_the_bio' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: 'distribution_link_placement must be first_comment | in_body',
  });
});

test('an operator hero dropped after the image stage re-stamps the provenance', { skip }, async () => {
  // The image stage recorded a hero it generated; the operator then replaces it
  // from the panel. A row still saying 'generated' would offer someone else's
  // file to a network for native upload, which is the one thing the column is
  // read for.
  const [row] = await q<{ id: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter,
                           hero_image_url, hero_image_source)
     VALUES ('A quiet commute', $1, 'Tech', 'guide', 'image', 'queued', $2::jsonb, $3, 'generated')
     RETURNING id`,
    [
      `operator-swap-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ title: 'A quiet commute', heroImage: 'https://x/operator.png' }),
      'https://x/operator.png',
    ],
  );
  articles.push(row.id);

  // Alt-only, which is the same write without needing image storage configured.
  const form = new FormData();
  form.set('alt', 'A commuter train at dusk');
  const res = await app.request(`/api/articles/${row.id}/hero-image`, {
    method: 'POST',
    headers: AUTH,
    body: form,
  });
  assert.equal(res.status, 200);

  const [after] = await q<{ hero_image_source: string | null }>(
    'SELECT hero_image_source FROM articles WHERE id = $1',
    [row.id],
  );
  assert.equal(after.hero_image_source, 'operator');

  const removed = await app.request(`/api/articles/${row.id}/hero-image`, {
    method: 'DELETE',
    headers: AUTH,
  });
  assert.equal(removed.status, 200);
  const [cleared] = await q<{ hero_image_source: string | null }>(
    'SELECT hero_image_source FROM articles WHERE id = $1',
    [row.id],
  );
  assert.equal(cleared.hero_image_source, null, 'the next image stage records what it finds');
});
