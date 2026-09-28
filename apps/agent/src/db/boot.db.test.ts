// The boot contract this exists for: the agent may start before Postgres does.
// A TCP proxy stands in for the database container - it starts refusing
// connections and only begins listening after the agent has already booted,
// exactly the ordering that used to kill the process on its first query.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';

/** Where the real database is, from the ambient DATABASE_URL or the PG* vars. */
function ambientUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = encodeURIComponent(process.env.PGUSER || 'postgres');
  const password = encodeURIComponent(process.env.PGPASSWORD || '');
  const host = process.env.PGHOST || 'localhost';
  const port = process.env.PGPORT || '5432';
  const database = process.env.PGDATABASE || process.env.PGUSER || 'postgres';
  return `postgres://${user}:${password}@${host}:${port}/${encodeURIComponent(database)}`;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const upstream = new URL(ambientUrl());
const upstreamPool = new pg.Pool({ connectionString: upstream.href, max: 1 });
const reachable = await upstreamPool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
await upstreamPool.end();
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const proxyPort = await freePort();
const proxyUrl = new URL(upstream.href);
proxyUrl.hostname = '127.0.0.1';
proxyUrl.port = String(proxyPort);
process.env.DATABASE_URL = proxyUrl.href;

const { databaseTarget, isTransientConnectionError, pool, waitForDatabase } =
  await import('./pool.js');
const { migrate } = await import('./migrate.js');

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

const DATABASE_STARTS_AFTER_MS = 1_500;

after(async () => {
  await pool.end();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

test('boot waits for a database that arrives after the app', { skip }, async () => {
  const startedAt = Date.now();
  setTimeout(() => proxy.listen(proxyPort, '127.0.0.1'), DATABASE_STARTS_AFTER_MS).unref();

  await waitForDatabase(20_000);

  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed >= DATABASE_STARTS_AFTER_MS,
    `returned in ${elapsed}ms - the database was not actually late`,
  );
  assert.equal(databaseTarget(), `127.0.0.1:${proxyPort}`);
});

test('migrations run once the wait succeeds', { skip }, async () => {
  await migrate();
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM schema_migrations',
  );
  assert.ok(Number(rows[0].count) > 0, 'no migrations were recorded');
});

// Authentication is not a wait-it-out failure: a real 28P01 from a real server
// must be surfaced at once rather than retried for the whole boot window.
test('a live authentication failure is never retried', { skip }, async () => {
  const wrongPassword = new URL(upstream.href);
  wrongPassword.password = 'definitely-not-the-password';
  const probe = new pg.Pool({ connectionString: wrongPassword.href, max: 1 });
  const authError: unknown = await probe
    .query('SELECT 1')
    .then(() => new Error('expected authentication to fail'))
    .catch((err: unknown) => err);
  await probe.end();

  const code = (authError as NodeJS.ErrnoException).code;
  if (code === undefined) return; // a trust-auth server accepts any password

  assert.equal(code, '28P01');
  assert.ok(!isTransientConnectionError(authError));
});
