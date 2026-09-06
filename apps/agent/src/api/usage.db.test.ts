// Contract tests for GET /api/usage against a real Postgres: the SQL these
// routes run only fails on a live server (v0.10.0 shipped a daily-usage query
// whose `::date day` alias made every call 500), so the unreachable database
// server.test.ts points at cannot prove them. Point DATABASE_URL at a
// throwaway server to run them.
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
const AGENT = `usage-test-${randomUUID()}`;
const TODAY = 0;
const THREE_DAYS_AGO = 3;

interface Totals { runs: string; tokens_input: string; tokens_output: string; cost_usd: string }
interface Usage {
  byAgent: Array<Totals & { agent: string }>;
  byModel: Array<Totals & { model: string }>;
  daily: Array<{ day: string; runs: string; cost_usd: string }>;
}

async function getUsage(): Promise<{ status: number; body: Usage }> {
  const res = await app.fetch(new Request('http://localhost/api/usage', { headers: AUTH }));
  return { status: res.status, body: (await res.json()) as Usage };
}

async function insertSession(daysAgo: number, tokensIn: number, tokensOut: number, cost: string): Promise<void> {
  await q(
    `INSERT INTO agent_sessions (agent, model, status, tokens_input, tokens_output, cost_usd, started_at)
     VALUES ($1, $2, 'done', $3, $4, $5, $6::timestamptz - make_interval(days => $7))`,
    [AGENT, AGENT, tokensIn, tokensOut, cost, anchor, daysAgo],
  );
}

/** The day bucket Postgres puts `daysAgo` in, as epoch ms. Both the seeding and
 *  the expectation hang off one server timestamp, so neither the client's
 *  timezone nor a run that straddles midnight can move the answer. */
async function dayBucket(daysAgo: number): Promise<number> {
  const rows = await q<{ day: Date }>(
    'SELECT ($1::timestamptz - make_interval(days => $2))::date AS day',
    [anchor, daysAgo],
  );
  return rows[0].day.getTime();
}

/** Runs per day bucket, so assertions survive rows this test did not write. */
function runsByDay(usage: Usage): Map<number, number> {
  const daily = Array.isArray(usage.daily) ? usage.daily : [];
  return new Map(daily.map((row) => [new Date(row.day).getTime(), Number(row.runs)]));
}

let runsBefore = new Map<number, number>();
/** The server's own clock at seeding time - every day boundary derives from it. */
let anchor: Date;

before(async () => {
  if (!reachable) return;
  await migrate();
  anchor = (await q<{ now: Date }>('SELECT now() AS now'))[0].now;
  runsBefore = runsByDay((await getUsage()).body);
  await insertSession(TODAY, 100, 20, '0.500000');
  await insertSession(TODAY, 300, 40, '1.500000');
  await insertSession(THREE_DAYS_AGO, 50, 10, '0.250000');
});

after(async () => {
  if (reachable) await q('DELETE FROM agent_sessions WHERE agent = $1', [AGENT]);
  await pool.end();
});

test('GET /api/usage answers 200 with all three breakdowns', { skip }, async () => {
  const { status, body } = await getUsage();

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.byAgent), 'byAgent is an array');
  assert.ok(Array.isArray(body.byModel), 'byModel is an array');
  assert.ok(Array.isArray(body.daily), 'daily is an array');
});

test('the daily breakdown groups runs by calendar day', { skip }, async () => {
  const runsAfter = runsByDay((await getUsage()).body);
  const added = async (daysAgo: number): Promise<number> => {
    const bucket = await dayBucket(daysAgo);
    return (runsAfter.get(bucket) ?? 0) - (runsBefore.get(bucket) ?? 0);
  };

  assert.equal(await added(TODAY), 2);
  assert.equal(await added(THREE_DAYS_AGO), 1);
});

test('the daily breakdown comes back newest first', { skip }, async () => {
  const { body } = await getUsage();
  const days = body.daily.map((row) => new Date(row.day).getTime());

  assert.deepEqual(days, [...days].sort((a, b) => b - a));
});

test('per-agent and per-model rows sum the tokens and cost of their sessions', { skip }, async () => {
  const { body } = await getUsage();
  const agentRow = body.byAgent.find((row) => row.agent === AGENT);
  const modelRow = body.byModel.find((row) => row.model === AGENT);

  assert.ok(agentRow, 'the seeded agent appears in the per-agent breakdown');
  assert.ok(modelRow, 'the seeded model appears in the per-model breakdown');
  for (const row of [agentRow, modelRow]) {
    assert.equal(Number(row.runs), 3);
    assert.equal(Number(row.tokens_input), 450);
    assert.equal(Number(row.tokens_output), 70);
    assert.equal(Number(row.cost_usd), 2.25);
  }
});
