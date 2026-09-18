import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../lib/log.js';

const log = createLogger('db');

/**
 * With no DATABASE_URL the pool is built with no connection details at all, so
 * `pg` resolves them itself from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and
 * defaults to localhost:5432 - the standard port every non-laptop environment
 * (preview, CI service container, Cloud Run sidecar) actually listens on.
 * Encoding a literal here instead is how boot ended up dialing the
 * docker-compose host mapping :5544 in environments that never ran compose.
 */
export const pool = new pg.Pool(
  config.databaseUrl ? { connectionString: config.databaseUrl, max: 10 } : { max: 10 },
);

// An idle pooled client whose connection drops (database restart, network
// blip) emits on the pool itself, and an unhandled 'error' event takes the
// whole process down. The next query opens a fresh connection, so noting it is
// all the handling this needs.
pool.on('error', (err) => {
  log.warn('idle database connection dropped', { target: databaseTarget(), error: err });
});

/** The host:port the pool dials, so a failure names something operators can check. */
export function databaseTarget(): string {
  if (config.databaseUrl) {
    try {
      const url = new URL(config.databaseUrl);
      return `${url.hostname || 'localhost'}:${url.port || '5432'}`;
    } catch {
      return 'DATABASE_URL (unparseable)';
    }
  }
  return `${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}

/**
 * Where the target came from, so the operator knows which knob to turn. The
 * unset case is the one worth spelling out: `pg` then assembles the whole
 * connection from PG* and its own defaults, and the failures a mismatch there
 * produces - 28000 "no PostgreSQL user name specified in startup packet",
 * `role "root" does not exist`, a SASL "client password must be a string" -
 * never mention DATABASE_URL themselves.
 */
function databaseSource(): string {
  return config.databaseUrl
    ? 'that target comes from DATABASE_URL'
    : 'DATABASE_URL is unset, so that target and its credentials are resolved from ' +
        'PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE and the pg defaults';
}

/**
 * The one sentence an operator can act on when a connection cannot be opened -
 * whether nothing answered at all or the server rejected the handshake.
 * Shared by both entrypoints that connect - the server and `pnpm migrate`.
 */
export function databaseConnectionHint(err: unknown): string {
  const problem = isDatabaseUnreachableError(err)
    ? `no Postgres answering at ${databaseTarget()}`
    : `cannot open a database connection to ${databaseTarget()}`;
  return (
    `${problem} - ${databaseSource()}. Set DATABASE_URL to a reachable Postgres, or correct ` +
    'the PG* variables. Note port 5544 is the docker-compose host mapping from `pnpm db:up`: ' +
    'it is not valid inside a container.'
  );
}

/**
 * Nothing is listening, the host does not resolve, or the route/address family
 * is unusable: either way the target itself is what the operator must fix.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
]);

/**
 * Every code the failure carries. A connect error can arrive as an
 * AggregateError - `net` tries every address the host resolves to, and a
 * dual-stack `localhost` is two - whose own `code` is just the FIRST attempt's.
 * In a container with no usable IPv6 that first code is EADDRNOTAVAIL/
 * ENETUNREACH for `::1`, hiding the ECONNREFUSED from `127.0.0.1` underneath:
 * judging the aggregate by its top-level code alone would neither retry a
 * Postgres that is merely starting late nor print the hint naming DATABASE_URL.
 */
function errorCodes(err: unknown): string[] {
  const code = (err as { code?: unknown } | null)?.code;
  const codes = typeof code === 'string' ? [code] : [];
  if (err instanceof AggregateError) {
    for (const nested of err.errors) codes.push(...errorCodes(nested));
  }
  return codes;
}

/** Every message the failure carries, flattened the same way as its codes. */
function errorMessages(err: unknown): string[] {
  const messages = err instanceof Error ? [err.message] : [];
  if (err instanceof AggregateError) {
    for (const nested of err.errors) messages.push(...errorMessages(nested));
  }
  return messages;
}

export function isDatabaseUnreachableError(err: unknown): boolean {
  return errorCodes(err).some((code) => UNREACHABLE_CODES.has(code));
}

/**
 * Postgres answered, but refused the connection rather than running any SQL:
 * the connection-exception class (08xxx), invalid authorization (28xxx - both
 * a wrong password and the 28000 an empty startup packet or a missing role
 * produces), an unknown database (3D000), a server not taking connections yet
 * (57P03) and a full connection slot table (53300).
 */
const CONNECTION_SQLSTATES = new Set(['3D000', '53300', '57P03']);
const CONNECTION_SQLSTATE_CLASSES = ['08', '28'];

/**
 * The failure is about opening the connection, not about the SQL that ran - so
 * it is the target and its credentials the operator has to fix, and the hint
 * naming DATABASE_URL belongs on it. This deliberately reaches past
 * ECONNREFUSED: with DATABASE_URL unset, a container whose PG* variables are
 * absent or do not match the sidecar reaches a Postgres that is perfectly
 * reachable and is turned away by it, which is the same unactionable crash
 * unless it is explained the same way. The driver's own pre-handshake
 * complaint - a SASL "client password must be a string" when no password is
 * resolved - carries no code at all, so it is matched by message.
 */
export function isDatabaseConnectionError(err: unknown): boolean {
  if (isDatabaseUnreachableError(err)) return true;
  const rejected = errorCodes(err).some(
    (code) =>
      CONNECTION_SQLSTATES.has(code) || CONNECTION_SQLSTATE_CLASSES.includes(code.slice(0, 2)),
  );
  if (rejected) return true;
  return errorMessages(err).some((message) => /(^SASL:)|password must be a string/i.test(message));
}

/**
 * Worth retrying: the server is absent, still starting up (57P03), or dropped
 * the connection mid-handshake. Auth failures and unknown databases are
 * deliberately excluded - those never fix themselves, so waiting on them only
 * delays the error the operator needs to see.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (isDatabaseUnreachableError(err)) return true;
  const codes = errorCodes(err);
  if (codes.includes('ECONNRESET') || codes.includes('57P03')) return true;
  return errorMessages(err).some((message) => /the database system is starting up/i.test(message));
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 3_000;

/**
 * Block until the database answers `SELECT 1`, or rethrow the last error once
 * `timeoutMs` has passed. Boot order is not something a deployment guarantees:
 * a sidecar Postgres that becomes ready seconds after the app must not be fatal.
 */
export async function waitForDatabase(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let backoffMs = FIRST_RETRY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        log.info('database reachable', { target: databaseTarget(), attempts: attempt });
      }
      return;
    } catch (err) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || !isTransientConnectionError(err)) throw err;
      const retryInMs = Math.min(backoffMs, remainingMs);
      log.warn('database not reachable yet, retrying', {
        target: databaseTarget(),
        attempt,
        retry_in_ms: retryInMs,
        error: err,
      });
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
      backoffMs = Math.min(backoffMs * 2, MAX_RETRY_MS);
    }
  }
}

/** Convenience: run a parameterized query, return rows. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

/** Get a JSONB settings value (seeded by the migration). */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await q<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
