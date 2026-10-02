// The scout's write path, against the real topics table: suggestions are filed
// against the platform and edition that were scouted, an event-bound one keeps
// its start time, and one whose start time cannot be trusted is not filed.
//
// It needs the platform columns the multi-platform schema adds to `topics`
// (SLE-138's migration), and skips with that reason on a schema without them.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TAVILY_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_D1_TOKEN;
delete process.env.D1_DATABASE_ID;

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { UsageTracker } = await import('../llm/index.js');
const { withModelStub } = await import('../llm/modelStub.js');
const { promptContextFromSeed } = await import('./context.js');
const { runTopicScout } = await import('./topicScout.js');
const { sleekdropsSeed } = await import('../platform/sleekdrops/index.js');

import type { StubbedCall } from '../llm/modelStub.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
if (reachable) await migrate();
const scoped =
  reachable &&
  (
    await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'topics' AND column_name IN ('platform_id', 'edition_id', 'event_starts_at')`,
    )
  )[0].n === 3;
const skip = !reachable
  ? 'no reachable DATABASE_URL - start Postgres to run these'
  : scoped
    ? false
    : 'topics has no platform_id / edition_id / event_starts_at yet (SLE-138 migration)';

const ctx = promptContextFromSeed(sleekdropsSeed, 'au');
const RUN = `scout-test-${Date.now()}`;
const title = (name: string) => `${RUN} ${name}`;
const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d+Z$/, '+00:00');

after(async () => {
  if (scoped) await q('DELETE FROM topics WHERE title LIKE $1', [`${RUN}%`]);
  await pool.end();
});

test('suggestions are filed against the scouted platform and edition', { skip }, async () => {
  const calls: StubbedCall[] = [];
  const suggestion = (name: string, extra: Record<string, unknown> = {}) => ({
    title: title(name),
    category: 'Home',
    postType: 'guide',
    angle: 'a',
    keywords: ['k'],
    whyTrending: 'w',
    sources: ['https://example.com'],
    ...extra,
  });
  const inserted = await withModelStub(
    async (call) => {
      calls.push(call);
      return JSON.stringify({
        topics: [
          suggestion('plain'),
          suggestion('event', { eventStartsAt: inAWeek }),
          suggestion('started', { eventStartsAt: '2020-01-01T10:00:00+00:00' }),
          suggestion('no offset', { eventStartsAt: '2030-01-01T10:00:00' }),
          suggestion('not a category', { category: 'Racing' }),
          suggestion('unknown type', { postType: 'review' }),
        ],
      });
    },
    () => runTopicScout(ctx, 'm', new UsageTracker()),
  );

  assert.deepEqual(
    inserted.map((topic) => topic.title).sort(),
    [title('event'), title('plain'), title('unknown type')].sort(),
  );
  const rows = await q<{
    title: string;
    platform_id: string;
    edition_id: string;
    post_type: string;
    event_starts_at: Date | null;
  }>(
    `SELECT title, platform_id, edition_id, post_type, event_starts_at
     FROM topics WHERE title LIKE $1 ORDER BY title`,
    [`${RUN}%`],
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.platform_id, 'sleekdrops');
    assert.equal(row.edition_id, 'au');
  }
  const byTitle = new Map(rows.map((row) => [row.title, row]));
  assert.equal(byTitle.get(title('event'))?.event_starts_at?.toISOString(), new Date(inAWeek).toISOString());
  assert.equal(byTitle.get(title('plain'))?.event_starts_at, null);
  assert.equal(byTitle.get(title('unknown type'))?.post_type, 'article', "the platform's first post type");

  // A second sweep is told what this platform already has, and files nothing twice.
  const again = await withModelStub(
    async (call) => {
      calls.push(call);
      return JSON.stringify({ topics: [suggestion('plain')] });
    },
    () => runTopicScout(ctx, 'm', new UsageTracker()),
  );
  assert.deepEqual(again, []);
  assert.match(calls[1].prompt, new RegExp(`  - ${title('plain')}`));
});
