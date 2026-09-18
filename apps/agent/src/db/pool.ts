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
 * The one sentence an operator can act on when nothing answers where we dialed.
 * Shared by both entrypoints that connect - the server and `pnpm migrate`.
 */
export function unreachableDatabaseHint(): string {
  return (
    `no Postgres answering at ${databaseTarget()} - set DATABASE_URL to a reachable Postgres ` +
    '(or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE). Note port 5544 is the docker-compose ' +
    'host mapping from `pnpm db:up`: it is not valid inside a container.'
  );
}

/** Nothing is listening, or the host does not resolve: the target itself is wrong. */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function isDatabaseUnreachableError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && UNREACHABLE_CODES.has(code);
}

/**
 * Worth retrying: the server is absent, still starting up (57P03), or dropped
 * the connection mid-handshake. Auth failures and unknown databases are
 * deliberately excluded - those never fix themselves, so waiting on them only
 * delays the error the operator needs to see.
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (isDatabaseUnreachableError(err)) return true;
  if (errorCode(err) === 'ECONNRESET' || errorCode(err) === '57P03') return true;
  return err instanceof Error && /the database system is starting up/i.test(err.message);
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
