// The queue as a database contract: one item per channel however many times
// publish re-runs, nothing at all for a draft, and a claim that only ever
// picks up work a provider could actually do.
//
// Every assertion is scoped to the channels this file creates. `node --test`
// runs these files concurrently against one database and an enqueue fans out
// over every active connection, so counting rows site-wide would be counting
// another suite's fixtures.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const {
  claimNextItem,
  enqueuePublishedArticle,
  markPosted,
  recoverStrandedItems,
  releaseItem,
  startPostAttempt,
  POSTING_LEASE_SECONDS,
} = await import('./queue.js');

import type { DistributableArticle, DistributionQueueRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/**
 * Unique to this file, so a concurrent suite's queue is never claimed here -
 * and unique again per claiming test, because a claim takes the oldest due
 * item for a provider and the tests above leave items pending.
 */
const PROVIDER = `stub-queue-${randomUUID().slice(0, 8)}`;
const uniqueProvider = (): string => `${PROVIDER}-${randomUUID().slice(0, 8)}`;
const articles: string[] = [];
const connections: string[] = [];

after(async () => {
  if (reachable) {
    // The queue rows cascade with their connection.
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

async function connect(
  fields: { status?: string; expiresAt?: string | null; provider?: string } = {},
): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref, status, expires_at)
     VALUES ($1, $2, 'test-channel-token', $3, $4)
     RETURNING id`,
    [
      fields.provider ?? PROVIDER,
      `account-${randomUUID().slice(0, 8)}`,
      fields.status ?? 'active',
      fields.expiresAt ?? null,
    ],
  );
  connections.push(row.id);
  return row.id;
}

async function article(): Promise<DistributableArticle> {
  const [row] = await q<{ id: string; slug: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter)
     VALUES ('The headphones for a quiet commute', $1, 'Tech', 'guide', 'publish', 'queued', $2::jsonb)
     RETURNING id, slug`,
    [
      `quiet-commutes-${randomUUID().slice(0, 8)}`,
      JSON.stringify({
        title: 'The headphones for a quiet commute',
        dek: 'Four weeks on the 7:12, ranked.',
        heroImage: 'https://storage.googleapis.com/images/heroes/quiet.png',
      }),
    ],
  );
  articles.push(row.id);
  return {
    id: row.id,
    slug: row.slug,
    title: 'The headphones for a quiet commute',
    frontmatter: {
      title: 'The headphones for a quiet commute',
      dek: 'Four weeks on the 7:12, ranked.',
      heroImage: 'https://storage.googleapis.com/images/heroes/quiet.png',
    },
    hero_image_url: null,
    hero_image_source: 'generated',
  };
}

/** This file's rows for one slug, oldest first. */
async function itemsFor(slug: string): Promise<DistributionQueueRow[]> {
  return q<DistributionQueueRow>(
    `SELECT * FROM distribution_queue
      WHERE slug = $1 AND channel_connection_id = ANY($2) ORDER BY created_at`,
    [slug, connections],
  );
}

/** The one row a single connection holds for a slug. */
async function itemOn(slug: string, connectionId: string): Promise<DistributionQueueRow> {
  const [row] = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [slug, connectionId],
  );
  return row;
}

test('publishing the same article again queues nothing new', { skip }, async () => {
  const [first, second] = [await connect(), await connect()];
  const piece = await article();

  const initial = await enqueuePublishedArticle(piece, { d1Status: 'published' });
  assert.ok(initial.created >= 2, 'both connected channels got an item');

  const queued = await itemsFor(piece.slug!);
  assert.deepEqual(
    queued.map((row) => row.channel_connection_id).sort(),
    [first, second].sort(),
  );
  assert.deepEqual(queued.map((row) => row.status), ['pending', 'pending']);

  // The publish stage is re-entered by a republish, by a retry-from-stage and
  // by the editorial feedback loop. Every one of those is this call again.
  for (let pass = 0; pass < 3; pass++) {
    await enqueuePublishedArticle(piece, { d1Status: 'published' });
  }
  const after = await itemsFor(piece.slug!);
  assert.deepEqual(
    after.map((row) => row.id).sort(),
    queued.map((row) => row.id).sort(),
    'the same rows, not new ones',
  );
  assert.deepEqual(
    after.map((row) => row.created_at),
    queued.map((row) => row.created_at),
    'and untouched, so a re-entry cannot reset an item that is mid-flight',
  );
});

test('the unique key is the database, not the read-then-write', { skip }, async () => {
  const connection = await connect();
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  // Two publish passes racing each other both reach the INSERT; one of them
  // has to lose, and it has to lose in the database.
  await assert.rejects(
    q(
      `INSERT INTO distribution_queue (slug, channel_connection_id, provider, payload)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      [piece.slug, connection, PROVIDER],
    ),
    /duplicate key value violates unique constraint "distribution_queue_slug_channel_idx"/,
  );
});

test('a draft never enqueues', { skip }, async () => {
  await connect();
  const piece = await article();

  const outcome = await enqueuePublishedArticle(piece, { d1Status: 'draft' });
  assert.deepEqual(outcome, { created: 0, alreadyQueued: 0, skipped: 'draft' });
  const [row] = await q<{ n: string }>(
    'SELECT count(*) n FROM distribution_queue WHERE slug = $1',
    [piece.slug],
  );
  assert.equal(row.n, '0', 'a piece parked in D1 as a draft has nowhere to send a reader');
});

test('an article with no slug has no destination to post', { skip }, async () => {
  await connect();
  const piece = await article();
  assert.deepEqual(await enqueuePublishedArticle({ ...piece, slug: null }, { d1Status: 'published' }), {
    created: 0,
    alreadyQueued: 0,
    skipped: 'no-slug',
  });
});

test('a disconnected channel is not queued for', { skip }, async () => {
  const disabled = await connect({ status: 'disabled' });
  const reauth = await connect({ status: 'needs_reauth' });
  const piece = await article();

  await enqueuePublishedArticle(piece, { d1Status: 'published' });
  const queued = await itemsFor(piece.slug!);
  assert.equal(queued.some((row) => row.channel_connection_id === disabled), false);
  assert.equal(queued.some((row) => row.channel_connection_id === reauth), false);
});

test('the payload is rendered once, at enqueue', { skip }, async () => {
  await connect();
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const [row] = await itemsFor(piece.slug!);
  assert.equal(row.placement, 'first_comment', 'the setting default, per the link-cap reading');
  assert.equal(row.payload.expected.ogTitle, 'The headphones for a quiet commute');
  assert.equal(
    row.payload.imageUrl,
    'https://storage.googleapis.com/images/heroes/quiet.png',
    'a hero we generated is ours to upload',
  );
  assert.match(row.payload.url, /utm_source=stub-queue/);
});

// ── Claiming ───────────────────────────────────────────────────────────────

test('a claim takes one due item and spends no attempt', { skip }, async () => {
  const provider = uniqueProvider();
  await connect({ provider });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const claimed = await claimNextItem([provider]);
  assert.ok(claimed, 'the item was due');
  assert.equal(claimed.slug, piece.slug);
  assert.equal(claimed.status, 'posting');
  assert.equal(claimed.attempts, 0, 'waiting for a rebuild is not a provider call');

  assert.equal(await claimNextItem([provider]), null, 'and nobody else can take it');
});

test('an item waiting out a backoff is not due yet', { skip }, async () => {
  const provider = uniqueProvider();
  const connection = await connect({ provider });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const claimed = (await claimNextItem([provider]))!;
  await releaseItem(claimed.id, 900, 'waiting for the site: HTTP 404');
  assert.equal(await claimNextItem([provider]), null);

  const row = await itemOn(piece.slug!, connection);
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error, 'waiting for the site: HTTP 404');
  assert.equal(row.claimed_at, null);
});

test('work for a channel whose token has lapsed is left alone', { skip }, async () => {
  const provider = uniqueProvider();
  await connect({ provider, expiresAt: new Date(Date.now() - 3_600_000).toISOString() });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  assert.equal(
    await claimNextItem([provider]),
    null,
    'posting with a dead token burns attempts on a failure only an operator can fix',
  );
});

test('an item for a provider with no adapter installed is never claimed', { skip }, async () => {
  const provider = uniqueProvider();
  await connect({ provider });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  assert.equal(await claimNextItem([]), null);
  assert.equal(await claimNextItem(['some-other-network']), null);
});

test('an item stranded by a dead worker comes back, its attempt already spent', { skip }, async () => {
  const provider = uniqueProvider();
  const connection = await connect({ provider });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const claimed = (await claimNextItem([provider]))!;
  const attempts = await startPostAttempt(claimed.id);
  assert.equal(attempts, 1);
  // The worker dies here, between spending the attempt and recording anything.
  await q(
    'UPDATE distribution_queue SET claimed_at = now() - make_interval(secs => $2) WHERE id = $1',
    [claimed.id, POSTING_LEASE_SECONDS + 60],
  );

  assert.ok((await recoverStrandedItems()) >= 1);
  const row = await itemOn(piece.slug!, connection);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1, 'recovery must not hand an item an extra attempt');
  assert.match(row.last_error!, /worker stopped mid-post/);
});

test('a posted item is never taken back by recovery', { skip }, async () => {
  const provider = uniqueProvider();
  const connection = await connect({ provider });
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  const claimed = (await claimNextItem([provider]))!;
  await startPostAttempt(claimed.id);
  await markPosted(claimed.id, 'remote-post-1');
  await q(
    'UPDATE distribution_queue SET claimed_at = now() - make_interval(secs => $2) WHERE id = $1',
    [claimed.id, POSTING_LEASE_SECONDS + 60],
  );

  await recoverStrandedItems();
  const row = await itemOn(piece.slug!, connection);
  assert.equal(row.status, 'posted');
  assert.equal(row.remote_post_id, 'remote-post-1');
});
