// Boot as a container actually performs it: the real entrypoint in its own
// process, with DATABASE_URL unset and only the libpq PG* variables set.
// Nothing below the process boundary can prove this - the bug was that a
// connection string the code invented for itself beat the environment, so the
// deployed agent dialled 127.0.0.1:5544 and died before serving anything.
// Each boot gets its own throwaway database, so the workers the entrypoint
// starts can never touch rows another suite is asserting on - which needs a
// server this may CREATE DATABASE on, the same throwaway server the other
// .db suites already assume.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { pool, q } = await import('./pool.js');

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = join(AGENT_ROOT, 'src/index.ts');
const BOOT_TIMEOUT_MS = 60_000;

interface PgParams {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
}

/** The PG* form of whatever this suite's own pool is pointed at. */
function pgParams(): PgParams | null {
  const { DATABASE_URL, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = process.env;
  if (DATABASE_URL) {
    try {
      const url = new URL(DATABASE_URL);
      return {
        PGHOST: url.hostname || 'localhost',
        PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: url.pathname.slice(1),
      };
    } catch {
      return null;
    }
  }
  if (!PGHOST) return null;
  return {
    PGHOST,
    PGPORT: PGPORT ?? '5432',
    PGUSER: PGUSER ?? '',
    PGPASSWORD: PGPASSWORD ?? '',
    PGDATABASE: PGDATABASE ?? '',
  };
}

const params = pgParams();
const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip =
  reachable && params ? false : 'no reachable database - start Postgres to run these';

/** Non-null for every test that is not skipped; `skip` is what guards it. */
function requirePgParams(): PgParams {
  if (!params) throw new Error('no PG* parameters - this test should be skipped');
  return params;
}

const scratchDatabases: string[] = [];

after(async () => {
  for (const name of scratchDatabases) {
    await q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
  await pool.end();
});

/** An empty database of its own, so a boot's migrations start from nothing. */
async function createScratchDatabase(): Promise<string> {
  const name = `boot_test_${randomUUID().replace(/-/g, '')}`;
  await q(`CREATE DATABASE "${name}"`);
  scratchDatabases.push(name);
  return name;
}

/** Query the scratch database the child boot migrated, not this suite's own. */
async function queryDatabase<T extends pg.QueryResultRow>(
  database: string,
  sql: string,
): Promise<T[]> {
  const { PGHOST, PGPORT, PGUSER, PGPASSWORD } = requirePgParams();
  const client = new pg.Client({
    host: PGHOST,
    port: Number(PGPORT),
    user: PGUSER,
    password: PGPASSWORD,
    database,
  });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * A forwarder to the real server on `port`, held closed until `appear()` - a
 * database container that only becomes reachable after the agent has booted.
 */
function lateDatabase(port: number): { appear: () => void; close: () => void } {
  const { PGHOST, PGPORT } = requirePgParams();
  const open: Socket[] = [];
  const server = createServer((client) => {
    const upstream = connect({ host: PGHOST, port: Number(PGPORT) });
    open.push(client, upstream);
    client.pipe(upstream).pipe(client);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) socket.on('error', drop).on('close', drop);
  });
  return {
    appear: () => server.listen(port, '127.0.0.1'),
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

interface BootedAgent {
  output: () => string;
  exited: Promise<number | null>;
  kill: () => void;
}

/** Spawn `src/index.ts` the way `pnpm start` does, with a container's env. */
function bootAgent(env: Record<string, string>): BootedAgent {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: AGENT_ROOT,
    env: {
      ...process.env,
      // Empty rather than deleted: dotenv leaves keys that already exist in
      // the environment alone, so a developer's own .env cannot slip a
      // DATABASE_URL (or an admin token) into this boot.
      DATABASE_URL: '',
      ADMIN_TOKEN: '',
      // The entrypoint starts the pipeline workers; this one must claim
      // nothing, it only has to boot and answer.
      WORKER_CONCURRENCY: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { output: () => output, exited, kill: () => child.kill('SIGKILL') };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the health route the way up.sh and the Cloud Run check do. */
async function waitForHealth(agent: BootedAgent, port: number): Promise<Response> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    if (res) return res;
    await wait(200);
  }
  throw new Error(`agent never answered /api/health:\n${agent.output()}`);
}

/** Wait for the boot to log something, so a test can act on where it got to. */
async function waitForOutput(agent: BootedAgent, pattern: RegExp): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (pattern.test(agent.output())) return;
    await wait(100);
  }
  throw new Error(`boot never logged ${pattern}:\n${agent.output()}`);
}

/** Wait for the process to die, so an exit code can be asserted on. */
async function waitForExit(agent: BootedAgent): Promise<number | null> {
  // unref'd: a boot that exits early must not leave this deadline holding the
  // test process open for the rest of the timeout.
  const deadline = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), BOOT_TIMEOUT_MS).unref();
  });
  const code = await Promise.race([agent.exited, deadline]);
  if (code === 'timeout') {
    agent.kill();
    throw new Error(`agent did not exit:\n${agent.output()}`);
  }
  return code;
}

test('boots on PG* alone: migrates the database and serves /api/health', { skip }, async () => {
  const database = await createScratchDatabase();
  const port = await freePort();
  const agent = bootAgent({ ...requirePgParams(), PGDATABASE: database, PORT: String(port) });
  try {
    const res = await waitForHealth(agent, port);
    assert.equal(res.status, 200, agent.output());
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(agent.output(), /\[migrate\] applied /);
  } finally {
    agent.kill();
    await agent.exited;
  }

  const applied = await queryDatabase<{ name: string }>(
    database,
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  assert.ok(applied.length > 0, 'the boot recorded its migrations in the scratch database');
});

test('a database that only appears later still gets migrated', { skip }, async () => {
  const database = await createScratchDatabase();
  const [port, dbPort] = [await freePort(), await freePort()];
  const late = lateDatabase(dbPort);
  const agent = bootAgent({
    ...requirePgParams(),
    PGHOST: '127.0.0.1',
    PGPORT: String(dbPort),
    PGDATABASE: database,
    PORT: String(port),
  });
  try {
    await waitForOutput(agent, /waiting for postgres at 127\.0\.0\.1:/);
    late.appear();
    const res = await waitForHealth(agent, port);
    assert.equal(res.status, 200, agent.output());
    assert.match(agent.output(), /\[migrate\] applied /, 'the wait ended in a migration');
  } finally {
    agent.kill();
    await agent.exited;
    late.close();
  }
});

test('waits for a database that is not listening yet', async () => {
  const agent = bootAgent({ PGHOST: '127.0.0.1', PGPORT: '1', PORT: String(await freePort()) });
  try {
    await waitForOutput(agent, /\(attempt 2\)/);
    const lines = agent.output();
    assert.match(lines, /\[agent\] waiting for postgres at 127\.0\.0\.1:1\/\S* \(attempt 1\)/);
    assert.match(lines, /\(attempt 2\)/, lines);
    assert.doesNotMatch(lines, /5544/, 'the laptop-only default must be gone');
  } finally {
    agent.kill();
    await agent.exited;
  }
});

test('exits 1 with the resolved target when the database is misconfigured', { skip }, async () => {
  const missing = `absent_${randomUUID().replace(/-/g, '')}`;
  const agent = bootAgent({
    ...requirePgParams(),
    PGDATABASE: missing,
    PORT: String(await freePort()),
  });
  const code = await waitForExit(agent);
  const output = agent.output();
  assert.equal(code, 1, output);
  assert.match(output, new RegExp(`cannot use the postgres at \\S+/${missing}\\.`));
  assert.match(output, /Set DATABASE_URL \(or PGHOST\/PGPORT/);
  assert.doesNotMatch(output, /waiting for postgres/, 'a database that is absent is not a race');
});
