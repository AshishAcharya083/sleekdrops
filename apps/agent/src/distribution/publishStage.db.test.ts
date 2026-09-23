// The pipeline stages that feed distribution, driven the way the worker
// drives them: `executeStage` on a real article row, against the real
// database. The D1 REST call and the GitHub dispatch are stubbed - everything
// else, including the enqueue, is the code the worker runs.
//
// This is the contract the card exists for: publish is re-entered by
// /api/articles/:id/republish, by a retry-from-stage and by the editorial
// feedback loop, and none of those may send a second post for the same slug.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
process.env.GITHUB_TOKEN = 'test-github-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { executeStage } = await import('../pipeline/runner.js');
const { createApp } = await import('../api/server.js');
const { runPublisher } = await import('../agents/publisher.js');
const { enqueuePublishedArticle } = await import('./queue.js');
const { UsageTracker } = await import('../llm/index.js');

import type { ArticleRow } from '../pipeline/types.js';
import type { DistributionQueueRow, HeroImageSource } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const PROVIDER = `stub-publish-${randomUUID().slice(0, 8)}`;
const TITLE = 'The headphones for a quiet commute';
const HERO = 'https://storage.googleapis.com/images/heroes/quiet.png';

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

const realFetch = globalThis.fetch;
const articles: string[] = [];
const connections: string[] = [];

after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) {
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

/** D1 and the repository dispatch, answered locally. */
function stubCloudflareAndGithub(): { dispatches: number } {
  const capture = { dispatches: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('api.cloudflare.com')) {
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    capture.dispatches += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return capture;
}

async function connect(): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, 'stub-publish-token') RETURNING id`,
    [PROVIDER, `page-${randomUUID().slice(0, 8)}`],
  );
  connections.push(row.id);
  return row.id;
}

async function article(fields: { heroImageSource?: HeroImageSource } = {}): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, draft_md,
                           frontmatter, affiliate_links, hero_image_source)
     VALUES ($1, $2, 'Tech', 'guide', 'publish', 'queued', 'The body.', $3::jsonb, '[]'::jsonb, $4)
     RETURNING *`,
    [
      TITLE,
      `quiet-commutes-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ title: TITLE, author: 'desk', pubDate: '2026-09-14', heroImage: HERO }),
      fields.heroImageSource ?? 'generated',
    ],
  );
  articles.push(row.id);
  return row;
}

/** Re-read the row the way the worker would on the next pass. */
async function reload(id: string): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]);
  return row;
}

async function itemsFor(slug: string, connectionId: string): Promise<DistributionQueueRow[]> {
  return q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [slug, connectionId],
  );
}

test('publish stage entered three times queues one item per channel', { skip }, async () => {
  const connection = await connect();
  const row = await article();
  stubCloudflareAndGithub();

  const first = await executeStage(row, 'publish', null, new UsageTracker());
  assert.match(first.summary, /queued for \d+ channel\(s\)/);
  assert.deepEqual(first.next, { stage: 'done', status: 'done' });

  const queued = await itemsFor(row.slug!, connection);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].provider, PROVIDER);
  assert.equal(queued[0].status, 'pending');

  // A republish, then the editorial feedback loop coming back round.
  const republish = await executeStage(await reload(row.id), 'publish', null, new UsageTracker());
  assert.match(republish.summary, /already queued/);
  await executeStage(await reload(row.id), 'publish', null, new UsageTracker());

  const after = await itemsFor(row.slug!, connection);
  assert.equal(after.length, 1, 'one published article, one post per channel');
  assert.equal(after[0].id, queued[0].id);
  assert.equal(after[0].attempts, 0);
});

test('the endpoints that re-enter publish cannot post the same piece twice', { skip }, async () => {
  // The two real doors into a second publish pass, driven the way the panel
  // drives them - same verb, same bearer, same JSON body - rather than by
  // calling the stage twice. Between them they are why this card exists: an
  // inline social post would have fired once per pass.
  const connection = await connect();
  const row = await article();
  stubCloudflareAndGithub();

  await executeStage(row, 'publish', null, new UsageTracker());
  const [first] = await itemsFor(row.slug!, connection);
  assert.ok(first, 'the first pass queued the piece');

  // `runStage` is what writes the routing decision the stage returned; the
  // stage body itself only reports it, so the finished state is set here.
  const settle = (status: string) =>
    q("UPDATE articles SET stage = 'done', status = $2 WHERE id = $1", [row.id, status]);

  await settle('done');
  const republished = await app.request(`/api/articles/${row.id}/republish`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(republished.status, 200);
  const requeued = await reload(row.id);
  assert.equal(requeued.stage, 'publish');
  assert.equal(requeued.status, 'queued', 'the worker will pick this up and run publish again');
  await executeStage(requeued, 'publish', null, new UsageTracker());

  // Retry-from-stage, off a publish that failed - the case where re-sending
  // would be most tempting and most wrong, because the post already went out.
  await settle('failed');
  const retried = await app.request(`/api/articles/${row.id}/retry-stage`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'publish' }),
  });
  assert.equal(retried.status, 200);
  const retriedRow = await reload(row.id);
  assert.equal(retriedRow.stage, 'publish');
  await executeStage(retriedRow, 'publish', null, new UsageTracker());

  const after = await itemsFor(row.slug!, connection);
  assert.equal(after.length, 1, 'three publish passes, one queued post');
  assert.equal(after[0].id, first.id, 'the original row, not a replacement');
  // `pg` hands these back as Date objects, so compare by value.
  assert.deepEqual(after[0].created_at, first.created_at, 'and untouched by the later passes');
});

test('an item already in flight is not reset by a republish', { skip }, async () => {
  const connection = await connect();
  const row = await article();
  stubCloudflareAndGithub();
  await executeStage(row, 'publish', null, new UsageTracker());

  const [item] = await itemsFor(row.slug!, connection);
  await q(
    `UPDATE distribution_queue SET status = 'posted', remote_post_id = 'remote-1',
            posted_at = now() WHERE id = $1`,
    [item.id],
  );

  await executeStage(await reload(row.id), 'publish', null, new UsageTracker());
  const [after] = await itemsFor(row.slug!, connection);
  assert.equal(after.status, 'posted', 'a re-entered publish must not post the same piece twice');
  assert.equal(after.remote_post_id, 'remote-1');
});

test('a draft publish pass enqueues nothing', { skip }, async () => {
  const connection = await connect();
  const row = await article();
  const capture = stubCloudflareAndGithub();

  // The draft pass is asked for directly rather than by flipping the global
  // `publish_mode` setting - every *.db.test.ts file shares this database and
  // `node --test` runs them concurrently. These two lines are what the publish
  // stage does, with the publisher's own reading of the mode.
  const result = await runPublisher(row, { publishMode: 'draft' });
  assert.equal(result.d1Status, 'draft');
  const outcome = await enqueuePublishedArticle(row, { d1Status: result.d1Status });

  assert.equal(outcome.skipped, 'draft');
  assert.equal(capture.dispatches, 0, 'the same guard the rebuild dispatch is behind');
  assert.deepEqual(await itemsFor(row.slug!, connection), []);
});

test('the queued payload carries the hero provenance the publish stage stored', { skip }, async () => {
  const connection = await connect();
  const row = await article({ heroImageSource: 'found' });
  stubCloudflareAndGithub();

  await executeStage(row, 'publish', null, new UsageTracker());
  const [item] = await itemsFor(row.slug!, connection);
  assert.equal(item.payload.imageSource, 'found');
  assert.equal(item.payload.imageUrl, null, 'a photograph we found is not ours to sublicense');
  assert.equal(item.payload.expected.ogImage, HERO, 'the page still has to serve it, though');
});

test('the image stage records an operator hero as operator-supplied', { skip }, async () => {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter,
                           hero_image_url, hero_alt)
     VALUES ($1, $2, 'Tech', 'guide', 'image', 'queued', $3::jsonb, $4, 'A commuter train')
     RETURNING *`,
    [
      TITLE,
      `operator-hero-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ title: TITLE, heroImage: HERO }),
      HERO,
    ],
  );
  articles.push(row.id);

  const outcome = await executeStage(row, 'image', null, new UsageTracker());
  assert.match(outcome.summary, /operator-supplied hero image/);
  assert.equal(
    (await reload(row.id)).hero_image_source,
    'operator',
    'provenance is a rights decision, so it is stored rather than inferred from the summary',
  );
});
