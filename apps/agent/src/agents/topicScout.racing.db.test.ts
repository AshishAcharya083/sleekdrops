// The scout's hard racing block, against the real topics table: whatever the
// model returns, PeakOdds files no horse, greyhound or harness racing topic,
// and SleekDrops - which blocks no topic class - is not filtered at all.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TAVILY_API_KEY;
delete process.env.CLOUDFLARE_ACCOUNT_ID;
delete process.env.CLOUDFLARE_D1_TOKEN;
delete process.env.D1_DATABASE_ID;
delete process.env.PEAKODDS_D1_DATABASE_ID;

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { UsageTracker } = await import('../llm/index.js');
const { withModelStub } = await import('../llm/modelStub.js');
const { promptContextFromSeed } = await import('./context.js');
const { runTopicScout } = await import('./topicScout.js');
const { seedPlatforms } = await import('../platform/profiles.js');
const { peakoddsSeed } = await import('../platform/peakodds/index.js');
const { sleekdropsSeed } = await import('../platform/sleekdrops/index.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
if (reachable) {
  await migrate();
  await seedPlatforms();
}
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const RUN = `scout-racing-${Date.now()}`;
const title = (name: string) => `${RUN} ${name}`;

after(async () => {
  if (reachable) await q('DELETE FROM topics WHERE title LIKE $1', [`${RUN}%`]);
  await pool.end();
});

function suggestion(name: string, category: string, extra: Record<string, unknown> = {}) {
  return {
    title: title(name),
    category,
    postType: 'preview',
    angle: 'the lean and why',
    keywords: ['tips'],
    whyTrending: 'w',
    sources: ['https://example.com'],
    ...extra,
  };
}

test('PeakOdds drops every racing topic the model suggests', { skip }, async () => {
  for (const editionId of ['au', 'global']) {
    const ctx = promptContextFromSeed(peakoddsSeed, editionId);
    const inserted = await withModelStub(
      async () =>
        JSON.stringify({
          topics: [
            suggestion(`${editionId} Swans v Lions tips`, 'AFL'),
            suggestion(`${editionId} Melbourne Cup tips`, 'AFL'),
            suggestion(`${editionId} Greyhound tips for Friday`, 'Football'),
            suggestion(`${editionId} Saturday night tips`, 'NRL', { angle: 'harness racing at Menangle' }),
            suggestion(`${editionId} Weekend best bets`, 'Cricket', { keywords: ['thoroughbred tips'] }),
            suggestion(`${editionId} Title race tips`, 'Football'),
          ],
        }),
      () => runTopicScout(ctx, 'm', new UsageTracker()),
    );
    assert.deepEqual(
      inserted.map((topic) => topic.title).sort(),
      [title(`${editionId} Swans v Lions tips`), title(`${editionId} Title race tips`)].sort(),
      editionId,
    );
  }
  const rows = await q<{ title: string; platform_id: string; edition_id: string }>(
    'SELECT title, platform_id, edition_id FROM topics WHERE title LIKE $1 ORDER BY title',
    [`${RUN}%`],
  );
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.platform_id === 'peakodds'));
  assert.deepEqual([...new Set(rows.map((row) => row.edition_id))].sort(), ['au', 'global']);
});

test('SleekDrops blocks no topic class, so the filter drops nothing there', { skip }, async () => {
  const ctx = promptContextFromSeed(sleekdropsSeed, 'au');
  const inserted = await withModelStub(
    async () =>
      JSON.stringify({
        topics: [suggestion('sleekdrops Greyhound coats for winter', 'Home', { postType: 'guide' })],
      }),
    () => runTopicScout(ctx, 'm', new UsageTracker()),
  );
  assert.deepEqual(
    inserted.map((topic) => topic.title),
    [title('sleekdrops Greyhound coats for winter')],
  );
});
