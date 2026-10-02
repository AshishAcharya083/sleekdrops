// A second platform's article run through the real runner and the real
// test-stage endpoint body, against Postgres.
//
// The prompt context already comes from the claimed row; these pin that the
// rows the runner writes and the settings it reads do too. A session written
// under SleekDrops for another platform's article puts its tokens and cost on
// the wrong brand in the platform-scoped admin, and a publish mode read from
// SleekDrops decides whether another brand's article waits for approval.
// Point DATABASE_URL at a throwaway server to run these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
// Before config.js is loaded: the could-not-start case is driven by a Claude
// model with no credential, and an inherited token would turn it into a live
// model call.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { executeStage, runStage } = await import('./runner.js');
const { runTestStage } = await import('./testStage.js');
const { resolvePromptContext } = await import('../agents/context.js');
const { PLATFORM_SEEDS, seedPlatforms } = await import('../platform/profiles.js');
const { sleekdropsSeed, SLEEKDROPS_PLATFORM_ID } = await import('../platform/sleekdrops/index.js');
const { UsageTracker } = await import('../llm/index.js');

import type { PlatformSeed } from '../platform/types.js';
import type { ArticleRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const PLATFORM_ID = 'scope-test';

const seed: PlatformSeed = {
  platform: {
    ...sleekdropsSeed.platform,
    id: PLATFORM_ID,
    name: 'Scope test',
    monetisation: 'none',
    publishTarget: {
      d1DatabaseIdEnv: 'SCOPE_TEST_D1_DATABASE_ID',
      githubRepoEnv: 'SCOPE_TEST_GITHUB_REPO',
      siteUrlEnv: 'SCOPE_TEST_SITE_URL',
      rebuildHookEnv: null,
    },
  },
  editions: [
    { id: 'global', name: 'Global', timeZone: 'UTC', currency: null, locale: 'en-GB', scoutQueries: [], complianceFooter: '' },
  ],
};

if (reachable) {
  await migrate();
  const seeds = PLATFORM_SEEDS as PlatformSeed[];
  seeds.push(seed);
  try {
    await seedPlatforms();
  } finally {
    seeds.splice(seeds.indexOf(seed), 1);
  }
}

const created: string[] = [];

after(async () => {
  if (reachable && created.length > 0) {
    await q('DELETE FROM agent_sessions WHERE article_id = ANY($1)', [created]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

async function insertArticle(fields: Record<string, unknown>): Promise<ArticleRow> {
  const row = {
    platform_id: PLATFORM_ID,
    edition_id: 'global',
    title: `Scope test ${randomUUID().slice(0, 8)}`,
    category: 'Tech',
    post_type: 'guide',
    // A running row with no live lease is lapsed to any other db test file's
    // reaper, which would re-queue it mid-test.
    lease_expires_at: new Date(Date.now() + 10 * 60_000),
    ...fields,
  };
  const keys = Object.keys(row);
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  created.push(inserted.id);
  return inserted;
}

const sessionPlatforms = async (articleId: string): Promise<string[]> =>
  (await q<{ platform_id: string }>('SELECT platform_id FROM agent_sessions WHERE article_id = $1', [articleId])).map(
    (r) => r.platform_id,
  );

test("a stage's session is recorded under the article's platform", { skip }, async () => {
  const article = await insertArticle({
    stage: 'assemble', status: 'running', claimed_by: 'test-worker', claimed_at: new Date(),
  });

  await runStage(article, async () => ({ next: { stage: 'done', status: 'done' }, summary: 'stubbed' }));

  assert.deepEqual(await sessionPlatforms(article.id), [PLATFORM_ID]);
});

test("a stage that cannot start is recorded under the article's platform", { skip }, async () => {
  // The default engine is Claude and this platform has no Claude credential,
  // so the keyword stage refuses to start before it opens a session.
  const article = await insertArticle({
    stage: 'keyword', status: 'running', claimed_by: 'test-worker', claimed_at: new Date(),
  });

  await runStage(article);

  const [session] = await q<{ platform_id: string; summary: string }>(
    'SELECT platform_id, summary FROM agent_sessions WHERE article_id = $1',
    [article.id],
  );
  assert.equal(session.summary, 'keyword could not start');
  assert.equal(session.platform_id, PLATFORM_ID);
});

test("the image stage hands off by the article's platform's publish mode", { skip }, async () => {
  // The opposite of whatever SleekDrops has, so reading SleekDrops' setting
  // would give the other answer.
  const sleekdropsMode = await getSetting<string>(SLEEKDROPS_PLATFORM_ID, 'publish_mode', 'approval');
  const ownMode = sleekdropsMode === 'approval' ? 'auto' : 'approval';
  await setSetting(PLATFORM_ID, 'publish_mode', ownMode);

  const article = await insertArticle({
    stage: 'image',
    status: 'running',
    frontmatter: JSON.stringify({ heroImage: 'https://images.example/hero.jpg' }),
  });
  const ctx = await resolvePromptContext(PLATFORM_ID, 'global');

  const { next } = await executeStage(article, 'image', null, new UsageTracker(), ctx);

  assert.deepEqual(next, { stage: 'publish', status: ownMode === 'approval' ? 'waiting_approval' : 'queued' });
});

test("a test run's session is recorded under the article's platform", { skip }, async () => {
  const article = await insertArticle({ stage: 'assemble', status: 'failed', draft_md: 'A draft.' });

  await runTestStage(article, 'assemble', async () => ({ ok: true }));

  assert.deepEqual(await sessionPlatforms(article.id), [PLATFORM_ID]);
});
