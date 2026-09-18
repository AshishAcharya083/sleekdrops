// The boot sequence src/index.ts actually runs, against a real Postgres:
// readiness wait → migrate → the server answers /api/health. A clean unit run
// cannot prove this - the v0.14.0 crash was the first query of the first step
// reaching a port nothing listened on, and only a live server distinguishes
// "reachable" from "resolved a DSN".
//
// Skips itself when no DATABASE_URL answers, like the other .db suites.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q, waitForDatabase } = await import('./pool.js');
const { migrate } = await import('./migrate.js');
const { createApp } = await import('../api/server.js');

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

after(async () => {
  if (reachable) await pool.end();
});

test('the readiness wait resolves against a live database', { skip }, async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  try {
    await waitForDatabase();
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warnings, [], 'a database that is up must not be retried');
});

test('migrate applies every migration file and records it', { skip }, async () => {
  await migrate();
  const applied = new Set((await q<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    assert.ok(applied.has(file), `${file} was not recorded in schema_migrations`);
  }
});

test('migrate is a no-op on a schema that is already current', { skip }, async () => {
  await migrate();
  await migrate();
});

test('GET /api/health answers 200 once the schema is in place', { skip }, async () => {
  await migrate();
  const app = createApp();
  // Unauthenticated on purpose: /api/health is the probe `up.sh` and the
  // platform poll, and it is exempt from the ADMIN_TOKEN guard.
  const res = await app.fetch(new Request('http://localhost/api/health'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
