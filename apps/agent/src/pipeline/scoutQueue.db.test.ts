// Queue behavior is a database contract: requests must remain durable, a live
// worker must serialize claims, and abandoned work must become claimable again.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const {
  claimNextScoutRun,
  enqueueScoutRun,
  recoverStaleScoutRuns,
  renewScoutHeartbeat,
  scoutQueueStatus,
} = await import('./scout.js');
const { recoverStranded } = await import('./worker.js');
const { createApp } = await import('../api/server.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
const created: string[] = [];

after(async () => {
  if (reachable && created.length > 0) {
    await q('DELETE FROM agent_sessions WHERE scout_run_id = ANY($1)', [created]);
    await q('DELETE FROM scout_runs WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

async function seed(
  status: 'queued' | 'running',
  heartbeatMinutesAgo = 0,
  startedAt = '2000-01-01T00:00:00Z',
): Promise<string> {
  const [run] = await q<{ id: string }>(
    `INSERT INTO scout_runs (status, started_at, claimed_at, heartbeat_at)
     VALUES ($1, $2, CASE WHEN $1 = 'running' THEN now() ELSE NULL END,
             now() - make_interval(mins => $3))
     RETURNING id`,
    [status, startedAt, heartbeatMinutesAgo],
  );
  created.push(run.id);
  return run.id;
}

async function statusOf(id: string): Promise<{ status: string; claimed_at: Date | null }> {
  const [row] = await q<{ status: string; claimed_at: Date | null }>(
    'SELECT status, claimed_at FROM scout_runs WHERE id = $1',
    [id],
  );
  return row;
}

test('POST /api/scout queues behind a live search instead of returning 409', { skip }, async () => {
  const running = await seed('running', 0);
  const before = await scoutQueueStatus();

  const response = await app.fetch(
    new Request('http://localhost/api/scout', { method: 'POST', headers: AUTH }),
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as { queued: string };
  created.push(body.queued);

  assert.equal((await statusOf(body.queued)).status, 'queued');
  const after = await scoutQueueStatus();
  assert.equal(after.running, before.running);
  assert.equal(after.queued, before.queued + 1);

  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [running]);
  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [body.queued]);
});

test('a worker claims the oldest queued search and will not overlap a live one', { skip }, async () => {
  const first = await seed('queued', 0, '1999-01-01T00:00:00Z');
  const second = await seed('queued', 0, '1999-01-02T00:00:00Z');

  const claims = await Promise.all([claimNextScoutRun(), claimNextScoutRun()]);
  assert.equal(claims.filter((id) => id === first).length, 1);
  assert.equal(claims.filter((id) => id === null).length, 1);
  assert.equal((await statusOf(first)).status, 'running');
  assert.ok((await statusOf(first)).claimed_at);

  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [first]);
  assert.equal(await claimNextScoutRun(), second);
  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [second]);
});

test('a stranded search is re-queued and its abandoned session is closed', { skip }, async () => {
  const stale = await seed('running', 31, '1998-01-01T00:00:00Z');
  await q(
    "INSERT INTO agent_sessions (scout_run_id, agent) VALUES ($1, 'topic_scout')",
    [stale],
  );

  await recoverStaleScoutRuns();

  const recovered = await statusOf(stale);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.claimed_at, null);
  const [session] = await q<{ status: string; error: string }>(
    'SELECT status, error FROM agent_sessions WHERE scout_run_id = $1',
    [stale],
  );
  assert.equal(session.status, 'failed');
  assert.match(session.error, /re-queued/);
  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [stale]);
});

test('recoverStranded includes topic-search jobs and a claimed job can heartbeat', { skip }, async () => {
  const stale = await seed('running', 31, '1997-01-01T00:00:00Z');
  await recoverStranded();
  assert.equal((await statusOf(stale)).status, 'queued');

  assert.equal(await claimNextScoutRun(), stale);
  assert.equal(await renewScoutHeartbeat(stale), true);
  await q("UPDATE scout_runs SET status = 'done', ended_at = now() WHERE id = $1", [stale]);
});

test('enqueueScoutRun uses the queued state by default', { skip }, async () => {
  const id = await enqueueScoutRun();
  created.push(id);
  assert.equal((await statusOf(id)).status, 'queued');
});
