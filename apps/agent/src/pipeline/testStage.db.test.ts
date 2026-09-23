// The budget around an isolated stage test.
//
// A test run is one HTTP request: it holds no lease, so the reaper cannot see
// it and nothing else will ever stop it. The hang that made the pipeline need
// a budget at all - a search-enabled review that never comes back - would
// simply move here and hold the request open forever, with the spend it made
// on the way never recorded. This file pins that it does not.
//
// Its own file because the budget has to be small to be testable, and
// AGENT_RUN_TIMEOUT_SECONDS is read once per process: a one-second budget
// inside retryStage.db.test.ts would race every other test-stage case there.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.AGENT_RUN_TIMEOUT_SECONDS = '1';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { runTestStage } = await import('./testStage.js');
const { stageBudgetSeconds } = await import('./budgets.js');

import type { ArticleRow } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const created: string[] = [];

after(async () => {
  if (reachable && created.length > 0) {
    await q('DELETE FROM agent_sessions WHERE article_id = ANY($1)', [created]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

async function seed(): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, draft_md, attempt)
     VALUES ('Test-stage budget card', 'Tech', 'guide', 'assemble', 'failed', 'A draft.', 3)
     RETURNING *`,
  );
  created.push(row.id);
  return row;
}

/** A stage body that never settles - the failure the budget exists for. */
const neverSettles = () => new Promise<never>(() => {});

test('the budget is the one the pipeline gives the same stage', { skip }, () => {
  assert.equal(stageBudgetSeconds('assemble'), 1, 'AGENT_RUN_TIMEOUT_SECONDS governs a test run too');
});

test('a test run that never comes back is stopped at its budget', { skip }, async () => {
  const article = await seed();

  await assert.rejects(
    runTestStage(article, 'assemble', neverSettles),
    /Stopped after 1 second \(the limit for the assembler agent\) at the assemble stage/,
  );

  const [session] = await q<{
    status: string;
    kind: string;
    summary: string;
    error: string;
    attempt: number;
  }>('SELECT status, kind, summary, error, attempt FROM agent_sessions WHERE article_id = $1', [
    article.id,
  ]);
  // A stage stopped by its budget is not a stage that failed, and the row says
  // so - the same distinction the pipeline records.
  assert.equal(session.status, 'timed_out');
  assert.equal(session.kind, 'test');
  assert.equal(session.attempt, 3, 'recorded against the attempt the article is on');
  // The shared timeout sentence ends by pointing at a saved draft; the summary
  // beside it is what keeps a test run honest about writing nothing.
  assert.equal(session.summary, 'assemble test timed out - nothing was written to the article');
  assert.match(session.error, /limit for the assembler agent/);

  const [unchanged] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);
  assert.equal(unchanged.status, 'failed', 'and the article is left exactly where it was');
  assert.equal(unchanged.stage, 'assemble');
  assert.equal(unchanged.frontmatter, null);
});
