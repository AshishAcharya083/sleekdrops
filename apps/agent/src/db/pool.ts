import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/**
 * Connection failures that only mean "not listening yet". Everything else -
 * bad password, unknown database, TLS refusal - is a real misconfiguration and
 * must surface on the first attempt rather than be retried for half a minute.
 */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', // nothing accepting on host:port yet
  'ENOTFOUND', // the database host has no DNS record yet
  'EAI_AGAIN', // ... the transient form of the same lookup
  '57P03', // Postgres cannot_connect_now: the cluster is still starting up
]);

/** The libpq/syscall code carried by a pg failure, when it carries one. */
export function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until `SELECT 1` answers. A database that is merely slow to start -
 * a platform booting Postgres alongside us, `up.sh` racing the container's
 * healthcheck - then costs a few seconds instead of the whole process.
 */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt >= attempts || !code || !TRANSIENT_CODES.has(code)) throw err;
      console.warn(
        `[db] ${config.databaseLabel} not ready (${code}) - attempt ${attempt}/${attempts}, retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
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
