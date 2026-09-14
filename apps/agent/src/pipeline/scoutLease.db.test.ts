// The scout lock where it actually bites: real Postgres rows, and the admin
// API the Topics tab drives with its own verbs.
//
// A sweep is a detached background task, so its 'running' scout_runs row is
// the only thing keeping two of them apart. Before the lease, a run killed
// with its Cloud Run instance held that row forever and every later sweep -
// manual or scheduled - answered 409 with nothing to act on. None of that is
// provable in memory: the lease is a timestamp comparison in SQL, and the
// refusal is an HTTP response. Point DATABASE_URL at a throwaway server to run
// these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';
// Before config.js loads: a started sweep is driven to fail at model
// resolution, and an inherited token would turn that into a live model call.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q, setSetting } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { formatAge, heldScoutLock, isScoutRunning, recoverStaleScoutRuns, renewScoutLease } =
  await import('./scout.js');
const { recoverStranded } = await import('./worker.js');
const { createApp } = await import('../api/server.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/** A Claude token in the database would make the "start a sweep" test call a model. */
const credentialled =
  reachable && (await getSetting<{ claude_token?: string }>('llm', {})).claude_token;
const startSkip = credentialled
  ? 'the database carries a Claude token - this test must not reach a live model'
  : skip;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

const created: string[] = [];

after(async () => {
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE scout_run_id = ANY($1)', [created]);
    await q('DELETE FROM scout_runs WHERE id = ANY($1)', [created]);
  }
  await pool.end();
});

/** A scout run whose last heartbeat was `heartbeatMinutesAgo` minutes ago. */
async function seedRunningRun(heartbeatMinutesAgo: number): Promise<string> {
  const [run] = await q<{ id: string }>(
    `INSERT INTO scout_runs (status, started_at, heartbeat_at)
     VALUES ('running', now() - make_interval(mins => $1), now() - make_interval(mins => $1))
     RETURNING id`,
    [heartbeatMinutesAgo],
  );
  created.push(run.id);
  await q(
    `INSERT INTO agent_sessions (scout_run_id, agent, started_at)
     VALUES ($1, 'topic_scout', now() - make_interval(mins => $2))`,
    [run.id, heartbeatMinutesAgo],
  );
  return run.id;
}

interface ScoutLockBody {
  lock: {
    id: string;
    started_at: string;
    heartbeat_at: string;
    age_seconds: number;
    heartbeat_age_seconds: number;
  } | null;
}

const getLock = async (): Promise<ScoutLockBody> => {
  const res = await app.fetch(new Request('http://localhost/api/scout/lock', { headers: AUTH }));
  assert.equal(res.status, 200);
  return (await res.json()) as ScoutLockBody;
};

const postScout = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await app.fetch(
    new Request('http://localhost/api/scout', { method: 'POST', headers: AUTH }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const deleteLock = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await app.fetch(
    new Request('http://localhost/api/scout/lock', { method: 'DELETE', headers: AUTH }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const statusOf = async (id: string): Promise<{ status: string; error: string | null }> => {
  const [row] = await q<{ status: string; error: string | null }>(
    'SELECT status, error FROM scout_runs WHERE id = $1',
    [id],
  );
  return row;
};

const heartbeatOf = async (id: string): Promise<string> => {
  const [row] = await q<{ heartbeat_at: Date }>(
    'SELECT heartbeat_at FROM scout_runs WHERE id = $1',
    [id],
  );
  return row.heartbeat_at.toISOString();
};

// Not a database test: the refusal above is only readable if the age in it is.
test('an age reads as an operator would say it', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(59.6), '1m');
  assert.equal(formatAge(1860), '31m');
  assert.equal(formatAge(7500), '2h 5m');
  assert.equal(formatAge(-5), '0s', 'a clock skew must not render a negative age');
});

test('a fresh run holds the lock and the refusal names it', { skip }, async () => {
  const id = await seedRunningRun(0);

  const { lock } = await getLock();
  assert.equal(lock?.id, id);
  assert.ok(lock.age_seconds >= 0 && lock.age_seconds < 60);

  const { status, body } = await postScout();
  assert.equal(status, 409);
  const message = String(body.error);
  // The panel renders this sentence verbatim (apps/admin/src/api.ts keeps the
  // agent's message on a 4xx), so it has to carry the run, its start and its age.
  assert.ok(message.includes(id), 'the refusal names the run holding the lock');
  assert.ok(message.includes(lock.started_at), 'and when it took the lock');
  assert.match(message, /\d+[smh].*ago/, 'the refusal states how long the lock has been held');
  assert.equal((body.lock as { id: string }).id, id, 'the lock is also returned structured');

  await deleteLock();
});

test('a run whose lease expired holds nothing', { skip }, async () => {
  const stale = await seedRunningRun(31);

  assert.equal((await getLock()).lock, null, 'a dead run is not reported as the lock holder');
  assert.equal(await isScoutRunning(), false, 'and the scheduler is free to sweep again');
  // Still 'running' until something sweeps it - the lease decides the lock, the
  // sweep decides the row.
  assert.equal((await statusOf(stale)).status, 'running');
});

// The heartbeat is what separates a sweep that is merely slow from one that
// died with its instance. Nothing else in this file can observe it: the
// interval is 60s and every run here reaches a terminal state in milliseconds,
// so these drive the renewal the interval calls directly.
test('a heartbeat pulls a run back inside its lease', { skip }, async () => {
  const id = await seedRunningRun(31);
  assert.equal((await getLock()).lock, null, 'the run starts outside the lease');
  const expired = await heartbeatOf(id);

  assert.equal(await renewScoutLease(id), true, 'a live run renews its own lease');

  assert.notEqual(await heartbeatOf(id), expired, 'the heartbeat actually advanced');
  const { lock } = await getLock();
  assert.equal(lock?.id, id, 'and the run holds the lock again');
  assert.ok(lock.heartbeat_age_seconds < 60, 'on a fresh lease');
  assert.equal(await isScoutRunning(), true, 'so a concurrent sweep is still kept out');

  await deleteLock();
});

test('a run that lost the lock cannot heartbeat its way back', { skip }, async () => {
  const cleared = await seedRunningRun(0);
  await deleteLock();
  const atRelease = await heartbeatOf(cleared);

  // The still-live task behind the cleared run keeps ticking for up to a
  // heartbeat before it notices; the status guard is what stops that tick from
  // overruling the operator.
  assert.equal(await renewScoutLease(cleared), false, 'there is no live row left to renew');

  assert.equal(await heartbeatOf(cleared), atRelease, 'a released run does not touch its lease');
  assert.equal((await statusOf(cleared)).status, 'failed', 'and stays terminal');
  assert.equal((await getLock()).lock, null, 'so the lock stays free for the next sweep');

  const swept = await seedRunningRun(31);
  await recoverStaleScoutRuns();
  const atSweep = await heartbeatOf(swept);
  assert.equal(await renewScoutLease(swept), false, 'the same holds for a swept run');
  assert.equal(await heartbeatOf(swept), atSweep, 'a swept run does not resurrect its lease');
});

test('the stale sweep moves an expired run to a terminal state', { skip }, async () => {
  const stale = await seedRunningRun(31);
  const fresh = await seedRunningRun(0);

  await recoverStaleScoutRuns();

  const swept = await statusOf(stale);
  assert.equal(swept.status, 'failed');
  assert.equal(swept.error, 'process restarted mid-run');
  assert.equal((await statusOf(fresh)).status, 'running', 'a live run is left alone');

  const [session] = await q<{ status: string; error: string }>(
    "SELECT status, error FROM agent_sessions WHERE scout_run_id = $1 AND agent = 'topic_scout'",
    [stale],
  );
  assert.equal(session.status, 'failed', 'the sweep does not leave a phantom session running');

  await deleteLock();
});

test('recoverStranded() releases scout locks on the same pass as articles', { skip }, async () => {
  const stale = await seedRunningRun(31);

  await recoverStranded();

  assert.equal((await statusOf(stale)).status, 'failed');
});

test('an operator can release a lock the lease has not expired yet', { skip }, async () => {
  const id = await seedRunningRun(0);

  const cleared = await deleteLock();
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, 1);

  const released = await statusOf(id);
  assert.equal(released.status, 'failed');
  assert.equal(released.error, 'lock cleared by operator');
  assert.equal((await getLock()).lock, null);

  const again = await deleteLock();
  assert.equal(again.status, 409, 'clearing a free lock is refused, not silently ok');
  assert.equal(again.body.error, 'no scout run is holding the lock');
});

test('the sweep the dead run used to block now starts', { skip: startSkip }, async () => {
  const dead = await seedRunningRun(31);
  await recoverStaleScoutRuns();

  // Force model resolution to fail so the sweep this starts is real up to the
  // point of the first model call and never makes one.
  const models = await getSetting<Record<string, string>>('models', {});
  await setSetting('models', { ...models, topic_scout: 'claude-opus-5' });
  try {
    const { status, body } = await postScout();
    assert.equal(status, 200, 'the next sweep is no longer refused');
    const started = String(body.started);
    created.push(started);
    assert.notEqual(started, dead);

    const [seeded] = await q<{ lease_age: number }>(
      'SELECT EXTRACT(EPOCH FROM now() - heartbeat_at)::int lease_age FROM scout_runs WHERE id = $1',
      [started],
    );
    assert.ok(seeded.lease_age < 60, 'a new run takes the lock with a fresh lease');

    // The run is a background task; it ends itself and gives the lock back.
    await waitForTerminal(started);
    assert.equal(await heldScoutLock(), null);
  } finally {
    await setSetting('models', models);
  }
});

/** The sweep is a background task: wait for it to leave 'running' on its own. */
async function waitForTerminal(id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await statusOf(id)).status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`scout run ${id} never reached a terminal status`);
}
