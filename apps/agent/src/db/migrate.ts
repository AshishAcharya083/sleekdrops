// Tiny forward-only SQL migration runner: applies src/db/migrations/*.sql in
// name order, recording each in schema_migrations. Safe to re-run, and safe to
// run from several processes at once.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import {
  databaseConnectionHint,
  isDatabaseConnectionError,
  pool,
  waitForDatabase,
} from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Arbitrary but stable, and the same number in every process: 'MIGR'.
 *
 * Reading schema_migrations and applying what is missing is only atomic for a
 * single caller. The test suite is not one: `node --test` runs each *.db.test.ts
 * in its own process, in parallel, and every one of them migrates on the way in,
 * so against an empty database they all see the same nothing applied and all try
 * to apply it - and collide on `CREATE TYPE` or on the schema_migrations insert.
 * Cloud Run has the same shape whenever a revision starts more than one
 * instance. The lock makes the read-then-apply one turn.
 */
const MIGRATION_LOCK = 0x4d494752;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK]);
  } catch (err) {
    client.release();
    throw err;
  }
  try {
    await applyPending(client);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}

/** Everything not yet recorded, in name order, on the caller's locked session. */
async function applyPending(client: pg.PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
}

// Allow `pnpm migrate` to run this standalone. It waits for the database like
// boot does: `pnpm db:up && pnpm db:migrate` reaches this while the Postgres
// container is still accepting no connections.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  waitForDatabase()
    .then(() => migrate())
    .then(() => pool.end())
    .catch((err) => {
      if (isDatabaseConnectionError(err)) console.error(`[migrate] ${databaseConnectionHint(err)}`);
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}
