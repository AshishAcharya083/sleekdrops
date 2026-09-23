// The migration runner under the concurrency it actually meets.
//
// Nothing calls migrate() once. `node --test` runs each *.db.test.ts in its own
// process, in parallel, and every one of them migrates on the way in, so an
// empty CI database gets a dozen simultaneous first migrations - which is
// exactly how this suite went red: several processes read the same empty
// schema_migrations, applied 001 on top of each other, and died on `CREATE
// TYPE` or on the duplicate schema_migrations insert before running a test.
//
// So this drives the real entry point the real way: separate processes, no
// shared module state to accidentally serialise them, against a throwaway
// schema so the collision has somewhere to happen on a database whose public
// schema is already migrated.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const { pool, q } = await import('./pool.js');
const { config } = await import('../config.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATE_ENTRY = join(HERE, 'migrate.ts');
// `--import tsx` resolves against the child's cwd, so pin it to this package
// rather than to whichever directory the suite happened to be started from.
const PACKAGE_ROOT = join(HERE, '..', '..');
const MIGRATION_FILES = readdirSync(join(HERE, 'migrations')).filter((f) => f.endsWith('.sql'));

const SCHEMA = `migrate_race_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** The same server, but with every unqualified name landing in SCHEMA. */
function childDatabaseUrl(): string {
  const separator = config.databaseUrl.includes('?') ? '&' : '?';
  return `${config.databaseUrl}${separator}options=-c%20search_path%3D${SCHEMA}`;
}

after(async () => {
  if (reachable) await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

test('simultaneous first migrations all succeed, and apply each file once', { skip }, async () => {
  await q(`CREATE SCHEMA ${SCHEMA}`);

  const env = { ...process.env, DATABASE_URL: childDatabaseUrl() };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      run(process.execPath, ['--import', 'tsx', MIGRATE_ENTRY], { cwd: PACKAGE_ROOT, env }),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected');
  assert.deepEqual(
    failed.map((r) => String((r as PromiseRejectedResult).reason)),
    [],
    'every concurrent migrate() must exit clean',
  );

  const applied = await q<{ name: string }>(
    `SELECT name FROM ${SCHEMA}.schema_migrations ORDER BY name`,
  );
  assert.deepEqual(
    applied.map((r) => r.name),
    [...MIGRATION_FILES].sort(),
    'each migration is recorded exactly once',
  );
});
