// The container's CMD is `pnpm --filter @sleekdrops/agent start`, i.e. this
// entrypoint - so the boot contract is tested the way the container runs it:
// spawn the real process and watch what it does. `pnpm migrate` is the other
// process that connects before anything else, and is spawned the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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

// What the agent resolves with no DATABASE_URL at all: `pg` reading PGHOST/
// PGPORT/... and defaulting to localhost:5432. Probing it with the same empty
// config the fixed pool builds is exactly the child's own resolution.
const pgEnvReachable = (await probe({})) === undefined;

/** Read through the same PG* resolution the child uses, so this proves its work. */
async function migrationsRecorded(): Promise<boolean> {
  const readPool = new pg.Pool({ max: 1 });
  try {
    const { rows } = await readPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    return Number(rows[0].count) > 0;
  } finally {
    await readPool.end();
  }
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
      assert.match(agent.output(), /set DATABASE_URL to a reachable Postgres/);
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
    const upstream = new URL(liveUrl);
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
// listened. With no default, `pg` resolves the standard port and boot completes.
test(
  'with no DATABASE_URL the agent boots on the PG* environment and serves health',
  {
    skip: pgEnvReachable ? false : 'no Postgres on the PG*/localhost:5432 default',
    timeout: 60_000,
  },
  async () => {
    const port = await freePort();
    const agent = bootAgent({
      DATABASE_URL: undefined,
      PORT: String(port),
      // config.ts loads dotenv, and a laptop running ./up.sh has an
      // apps/agent/.env holding the compose URL. Point dotenv at a file that
      // does not exist so the child really resolves from PG*/the pg defaults.
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
      assert.ok(await migrationsRecorded(), 'the agent served health with no migrations recorded');
      assert.doesNotMatch(agent.output(), /5544/);
      assert.doesNotMatch(agent.output(), /\[agent\] fatal/);
    } finally {
      agent.child.kill('SIGKILL');
      await agent.exited;
    }
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
