// The container's CMD is `pnpm --filter @sleekdrops/agent start`, i.e. this
// entrypoint - so the boot contract is tested the way the container runs it:
// spawn the real process and watch what it does. `pnpm migrate` is the other
// process that connects before anything else, and is spawned the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRYPOINT = join(PACKAGE_ROOT, 'src', 'index.ts');
const MIGRATE_CLI = join(PACKAGE_ROOT, 'src', 'db', 'migrate.ts');

/** The live database this sandbox/CI provides, or nothing. */
const liveUrl = process.env.DATABASE_URL ?? '';

async function probe(poolConfig: pg.PoolConfig): Promise<unknown> {
  const probePool = new pg.Pool({ ...poolConfig, max: 1 });
  const result = await probePool
    .query('SELECT 1')
    .then(() => undefined)
    .catch((err: unknown) => err);
  await probePool.end();
  return result;
}

const reachable = liveUrl ? (await probe({ connectionString: liveUrl })) === undefined : false;

async function migrationsRecorded(url: URL): Promise<boolean> {
  const readPool = new pg.Pool({ connectionString: url.href, max: 1 });
  try {
    const { rows } = await readPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    return Number(rows[0].count) > 0;
  } finally {
    await readPool.end();
  }
}

/**
 * A database of this child's own. `src/index.ts` boots the entire platform,
 * not just migrate + serve: recoverStranded() re-queues articles and fails
 * agent sessions older than 30 minutes, and startScoutWorker() immediately
 * recovers stale scout runs and claims the oldest queued one. Those are the
 * very rows the other *.db.test.ts suites seed and assert on, and node runs
 * test files in parallel - so a spawned agent must never be pointed at the
 * shared test database.
 */
async function scratchDatabase(): Promise<{ url: URL; drop: () => Promise<void> }> {
  const name = `agent_boot_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(liveUrl);
  url.pathname = `/${name}`;
  await onLiveServer(`CREATE DATABASE "${name}"`);
  return { url, drop: () => onLiveServer(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) };
}

/** Run one statement on the ambient database, which owns no test fixtures. */
async function onLiveServer(sql: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: liveUrl, max: 1 });
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** The PG* form of a connection, for a child that must run with no DATABASE_URL. */
function pgEnvironment(url: URL): Record<string, string> {
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
}

async function freePort(): Promise<number> {
  const probeServer = net.createServer();
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const { port } = probeServer.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));
  return port;
}

/** A trust-auth server has no credential error to fail fast on. */
async function rejectsWrongPassword(): Promise<boolean> {
  const wrongPassword = new URL(liveUrl);
  wrongPassword.password = 'definitely-not-the-password';
  return (await probe({ connectionString: wrongPassword.href })) !== undefined;
}

const skipLive: string | false = reachable
  ? false
  : 'no reachable DATABASE_URL - start Postgres to run these';

const skip: string | false = skipLive
  ? skipLive
  : (await rejectsWrongPassword())
    ? false
    : 'this Postgres accepts any password - no credential error to surface';

interface Booted {
  child: ChildProcess;
  output: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  exited: Promise<number | null>;
}

interface BootOptions {
  /** What to run: the agent entrypoint by default, or the standalone migrate CLI. */
  script?: string;
  /** An extra ESM module loaded before it, as a path or `data:` URL. */
  preload?: string;
}

/** Spawn the process with `overrides` applied to its env; an undefined value unsets. */
function bootAgent(
  overrides: Record<string, string | undefined>,
  { script = ENTRYPOINT, preload }: BootOptions = {},
): Booted {
  // PORT 0 by default keeps a booting agent off a port another suite may want.
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0', ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  const preloads = preload ? ['--import', preload] : [];
  const child = spawn(process.execPath, ['--import', 'tsx', ...preloads, script], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const waiters: Array<() => void> = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      output += chunk;
      for (const notify of waiters.splice(0)) notify();
    });
  }
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return {
    child,
    output: () => output,
    exited,
    waitFor: (pattern, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`never matched ${pattern}. Output:\n${output}`)),
          timeoutMs,
        );
        const check = (): void => {
          if (!pattern.test(output)) {
            waiters.push(check);
            return;
          }
          clearTimeout(deadline);
          resolve();
        };
        check();
        void exited.then(check);
      }),
  };
}

/** The boot wait window - `waitForDatabase`'s own default, spent before giving up. */
const BOOT_WAIT_MS = 30_000;

/**
 * A host resolving to two addresses, the way a container resolves `localhost` -
 * which is what the `pg` default and .env.example both dial. `net` then tries
 * every address, and when they all fail `pg` rejects with an AggregateError
 * whose own `code` is only the FIRST attempt's: for `::1` in a container with
 * no usable IPv6 that is EADDRNOTAVAIL, hiding the ECONNREFUSED underneath.
 * DNS is the only way to make one connection attempt fan out, so the stub is
 * preloaded into the child rather than reaching into the app.
 */
const DUAL_STACK_HOST = 'dualstack.test';
const DUAL_STACK_DNS_STUB = `data:text/javascript,${encodeURIComponent(`
import dns from 'node:dns';
const real = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (hostname !== ${JSON.stringify(DUAL_STACK_HOST)}) return real(hostname, options, callback);
  const done = typeof options === 'function' ? options : callback;
  const all = typeof options === 'object' && options !== null && options.all;
  const addresses = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  process.nextTick(() => (all ? done(null, addresses) : done(null, addresses[0].address, 6)));
};
`)}`;

test(
  'boot retries an unreachable database, then exits naming DATABASE_URL',
  { timeout: 120_000 },
  async () => {
    // Port 1 is unbound, so every connection is refused - the shape of the
    // failure that used to kill the process before the server ever listened.
    const agent = bootAgent({ DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unreachable' });
    const startedAt = Date.now();
    try {
      await agent.waitFor(/database not reachable yet, retrying/);
      await agent.waitFor(/"attempt":2/);
      assert.equal(agent.child.exitCode, null, 'the agent exited instead of waiting for Postgres');

      // Only when the whole window is spent does it give up - and what the
      // operator reads then is the dialed target and the variable to set,
      // rather than the bare ECONNREFUSED the demo failure produced.
      assert.equal(await agent.exited, 1, 'boot did not exit 1 once the wait window ran out');
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= BOOT_WAIT_MS, `gave up after ${elapsed}ms, before the window was spent`);
      assert.match(agent.output(), /no Postgres answering at 127\.0\.0\.1:1/);
      assert.match(agent.output(), /Set DATABASE_URL to a reachable Postgres/);
      assert.doesNotMatch(agent.output(), /listening/);
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
    }
  },
);

// The same wait, when the failure arrives bundled. Judging such an aggregate by
// its top-level code alone made boot treat a merely-late Postgres as fatal.
test(
  'boot waits through a dual-stack failure that arrives as an AggregateError',
  { timeout: 60_000 },
  async () => {
    const agent = bootAgent(
      { DATABASE_URL: `postgres://unused:unused@${DUAL_STACK_HOST}:1/unreachable` },
      { preload: DUAL_STACK_DNS_STUB },
    );
    try {
      await agent.waitFor(/database not reachable yet, retrying/);
      await agent.waitFor(/"attempt":2/);
      assert.match(agent.output(), new RegExp(`"target":"${DUAL_STACK_HOST}:1"`));
      assert.equal(agent.child.exitCode, null, 'the agent exited instead of waiting for Postgres');
      assert.doesNotMatch(agent.output(), /\[agent\] fatal/);
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
    }
  },
);

// The demo ordering itself: the app starts first and the database only answers
// seconds later. A TCP proxy stands in for the database container - it refuses
// connections until it starts listening - so boot has to recover and go on to
// migrate and serve instead of dying on the first refusal.
test(
  'boot recovers when the database only arrives after the app',
  { skip: skipLive, timeout: 90_000 },
  async () => {
    const scratch = await scratchDatabase();
    const upstream = scratch.url;
    const proxyPort = await freePort();
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const server = net.connect(Number(upstream.port || 5432), upstream.hostname);
      for (const socket of [client, server]) {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          server.destroy();
        });
      }
      client.pipe(server).pipe(client);
    });
    const proxyUrl = new URL(upstream.href);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(proxyPort);

    const port = await freePort();
    const agent = bootAgent({ DATABASE_URL: proxyUrl.href, PORT: String(port) });
    try {
      await agent.waitFor(/database not reachable yet, retrying/);
      proxy.listen(proxyPort, '127.0.0.1');

      await agent.waitFor(/admin API \+ panel listening/);
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.doesNotMatch(agent.output(), /\[agent\] fatal/);
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await scratch.drop();
    }
  },
);

test(
  'boot fails fast on a credential error rather than waiting out the window',
  { skip, timeout: 60_000 },
  async () => {
    const wrongPassword = new URL(liveUrl);
    wrongPassword.password = 'definitely-not-the-password';
    const agent = bootAgent({ DATABASE_URL: wrongPassword.href });
    const startedAt = Date.now();
    const exitCode = await agent.exited;

    assert.equal(exitCode, 1);
    assert.ok(
      Date.now() - startedAt < 25_000,
      'an authentication failure was retried instead of surfacing immediately',
    );
    assert.match(agent.output(), /\[agent\] fatal/);
    assert.match(agent.output(), /password authentication failed/i);
    assert.doesNotMatch(agent.output(), /retrying/);
  },
);

// The demo failure exactly: nothing sets DATABASE_URL, so the old hardcoded
// default dialed the compose-only :5544 and the process died before :8787 ever
// listened. With no default the child resolves everything through PG* like any
// container does - here at a database of its own, since it boots the whole
// pipeline. That the empty case then lands on localhost:5432 rather than 5544
// is asserted without a server in db/pool.noDatabaseUrl.test.ts.
test(
  'with no DATABASE_URL the agent boots on the PG* environment and serves health',
  { skip: skipLive, timeout: 60_000 },
  async () => {
    const scratch = await scratchDatabase();
    const port = await freePort();
    const agent = bootAgent({
      DATABASE_URL: undefined,
      ...pgEnvironment(scratch.url),
      PORT: String(port),
      // config.ts loads dotenv, and a laptop running ./up.sh has an
      // apps/agent/.env holding the compose URL. Point dotenv at a file that
      // does not exist so the child really resolves from PG*.
      DOTENV_CONFIG_PATH: join(PACKAGE_ROOT, '.env.does-not-exist'),
      DOTENV_CONFIG_QUIET: 'true',
    });
    try {
      await agent.waitFor(/admin API \+ panel listening/);

      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      // Migrations run before the server listens, so a 200 already implies
      // they applied - the runner's own bookkeeping says so explicitly.
      assert.ok(
        await migrationsRecorded(scratch.url),
        'the agent served health with no migrations recorded',
      );
      assert.doesNotMatch(agent.output(), /\[agent\] fatal/);
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
      await scratch.drop();
    }
  },
);

// The other half of having no DATABASE_URL: the target is reachable and turns
// the agent away. PG* that does not match the sidecar - here a database that
// does not exist, in a container just as often a missing PGUSER/PGPASSWORD -
// fails with a Postgres error that never mentions DATABASE_URL, which is the
// same unactionable crash the compose-only default produced.
test(
  'a rejected connection with no DATABASE_URL still names DATABASE_URL',
  { skip: skipLive, timeout: 60_000 },
  async () => {
    const absent = new URL(liveUrl);
    absent.pathname = '/agent_boot_no_such_database';
    const agent = bootAgent({
      DATABASE_URL: undefined,
      ...pgEnvironment(absent),
      DOTENV_CONFIG_PATH: join(PACKAGE_ROOT, '.env.does-not-exist'),
      DOTENV_CONFIG_QUIET: 'true',
    });

    assert.equal(await agent.exited, 1);
    assert.match(agent.output(), /DATABASE_URL is unset/);
    assert.match(agent.output(), /PGHOST\/PGPORT\/PGUSER\/PGPASSWORD\/PGDATABASE/);
    assert.match(agent.output(), new RegExp(`cannot open a database connection to ${absent.host}`));
    // Nothing about this fixes itself, so it must not spend the wait window.
    assert.doesNotMatch(agent.output(), /retrying/);
  },
);

// `pnpm db:up && pnpm db:migrate` runs this while the Postgres container is
// still starting, so the standalone runner needs the same patience as boot.
test('the migrate CLI waits for the database instead of failing on the first refusal', async () => {
  const migration = bootAgent(
    { DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unreachable' },
    { script: MIGRATE_CLI },
  );
  try {
    await migration.waitFor(/database not reachable yet, retrying/);
    await migration.waitFor(/"attempt":2/);
    assert.equal(migration.child.exitCode, null, 'migrate exited instead of waiting for Postgres');
    assert.doesNotMatch(migration.output(), /\[migrate\] failed/);
  } finally {
    migration.child.kill('SIGKILL');
    await migration.exited;
  }
});
