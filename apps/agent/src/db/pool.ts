import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

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
