// Contract tests for GET /api/overview against a real Postgres: the panel's
// landing screen polls this route every 4s, and a single failing query used to
// take the whole dashboard down with it. server.test.ts can only prove the
// case where *nothing* answers (its database points nowhere); the degraded
// case - five sections answering and one failing - only happens on a live
// server. Point DATABASE_URL at a throwaway server to run these.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('./server.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
/** Unique so the rows this file writes never collide with anything else. */
const AGENT = `overview-test-${randomUUID()}`;

interface OverviewBody {
  topics: Array<{ status: string; n: string }>;
  articles: Array<{ stage: string; status: string; n: string }>;
  runningSessions: number;
  usage30d: { costUsd: number; tokensInput: number; tokensOutput: number; runs: number };
  recentSessions: Array<{ agent: string; scout_run_id: string | null; article_title: string | null }>;
  publishMode: string;
  workerEnabled: boolean;
  failedSections: string[];
}

async function getOverview(): Promise<{ status: number; body: OverviewBody }> {
  const res = await app.fetch(new Request('http://localhost/api/overview', { headers: AUTH }));
  return { status: res.status, body: (await res.json()) as OverviewBody };
}

/** A scout session: the sweep has no article, only the run it belongs to. */
let scoutRunId = '';

before(async () => {
  if (!reachable) return;
  await migrate();
  await q(
    "INSERT INTO topics (title, norm_title, category, post_type) VALUES ($1, $1, 'Tech', 'article')",
    [AGENT],
  );
  const [run] = await q<{ id: string }>('INSERT INTO scout_runs DEFAULT VALUES RETURNING id');
  scoutRunId = run.id;
  await q(
    `INSERT INTO agent_sessions (agent, scout_run_id, status, cost_usd, tokens_input, tokens_output)
     VALUES ($1, $2, 'done', '0.250000', 100, 20)`,
    [AGENT, scoutRunId],
  );
});

after(async () => {
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE agent = $1', [AGENT]);
    await q('DELETE FROM scout_runs WHERE id = $1', [scoutRunId]);
    await q('DELETE FROM topics WHERE title = $1', [AGENT]);
  }
  await pool.end();
});

test('GET /api/overview answers 200 with every section the panel reads', { skip }, async () => {
  const { status, body } = await getOverview();

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.topics), 'topics is an array');
  assert.ok(Array.isArray(body.articles), 'articles is an array');
  assert.ok(Array.isArray(body.recentSessions), 'recentSessions is an array');
  assert.equal(typeof body.runningSessions, 'number');
  assert.equal(typeof body.usage30d.costUsd, 'number');
  assert.equal(typeof body.publishMode, 'string');
  assert.equal(typeof body.workerEnabled, 'boolean');
  assert.deepEqual(body.failedSections, [], 'a healthy database degrades nothing');
});

test('a scout session carries the run it swept for', { skip }, async () => {
  const { body } = await getOverview();
  const session = body.recentSessions.find((s) => s.agent === AGENT);

  assert.ok(session, 'the seeded session is in the recent list');
  // Without this column the panel can only ever render the em-dash placeholder,
  // never its "topic sweep" label, because a sweep has no article title.
  assert.equal(session.scout_run_id, scoutRunId);
  assert.equal(session.article_title, null);
});

test('one failing section degrades that figure alone, not the request', { skip }, async () => {
  // The topic-count query is made to fail the way a real outage would - the
  // relation it reads is not there - while the other five keep answering.
  await q('ALTER TABLE topics RENAME TO topics_overview_test');
  try {
    const { status, body } = await getOverview();

    assert.equal(status, 200, 'the dashboard must survive one broken query');
    assert.deepEqual(body.failedSections, ['topics'], 'the failure is named, not swallowed');
    assert.deepEqual(body.topics, [], 'the failed section falls back to an empty count');
    assert.ok(
      body.recentSessions.some((s) => s.agent === AGENT),
      'the sections that answered are still served',
    );
    assert.equal(body.usage30d.costUsd >= 0.25, true);
    assert.equal(typeof body.publishMode, 'string');
  } finally {
    await q('ALTER TABLE topics_overview_test RENAME TO topics');
  }
});
