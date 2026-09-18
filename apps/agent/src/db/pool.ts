import pg from 'pg';
import { config } from '../config.js';

/**
 * `connectionString` is passed only when DATABASE_URL is set: node-postgres
 * falls back to the standard libpq variables (PGHOST, PGPORT, PGUSER,
 * PGPASSWORD, PGDATABASE) only when it is given neither a connection string
 * nor a host, and in a container those variables are often the whole wiring.
 */
const poolOptions: pg.PoolConfig = { max: 10 };
if (config.databaseUrl) poolOptions.connectionString = config.databaseUrl;

export const pool = new pg.Pool(poolOptions);

/** pg's own defaults, so a log line names the address pg will actually dial. */
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '5432';

/**
 * The `host:port/database` this pool talks to, resolved the way the pool
 * itself resolves it - for log lines and boot failures, so an unreachable
 * database says which address was tried. Never includes the password.
 */
export function describeTarget(): string {
  if (!config.databaseUrl) {
    // pg defaults the database name to the user when PGDATABASE is unset.
    const { PGHOST, PGPORT, PGDATABASE, PGUSER } = process.env;
    return format(PGHOST, PGPORT, PGDATABASE || PGUSER);
  }
  try {
    const url = new URL(config.databaseUrl);
    return format(url.hostname, url.port, url.pathname.slice(1) || url.username);
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

function format(host?: string, port?: string, database?: string): string {
  return `${host || DEFAULT_HOST}:${port || DEFAULT_PORT}/${database || '(default)'}`;
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
