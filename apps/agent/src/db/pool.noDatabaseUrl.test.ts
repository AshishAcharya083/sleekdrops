// What the agent resolves when nothing sets DATABASE_URL: the demo failure's
// exact configuration, where the old hardcoded default dialed the
// docker-compose-only port 5544. This runs everywhere - it never connects - so
// the compose URL cannot creep back into config.ts behind a green CI, which
// the live boot suites cannot promise: they need a Postgres answering on the
// PG* defaults, and CI publishes its service container on 5544 instead.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// All of this must happen before config.ts is imported: it reads the
// environment once at module load, and its `import 'dotenv/config'` would
// otherwise pick up the apps/agent/.env a laptop running ./up.sh has.
process.env.DOTENV_CONFIG_PATH = join(PACKAGE_ROOT, '.env.does-not-exist');
process.env.DOTENV_CONFIG_QUIET = 'true';
for (const key of ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
  delete process.env[key];
}

const { config } = await import('../config.js');
const { databaseConnectionHint, databaseTarget, isDatabaseConnectionError, pool } =
  await import('./pool.js');

after(async () => {
  await pool.end();
});

test('an unset DATABASE_URL resolves to no connection string at all', () => {
  assert.equal(config.databaseUrl, '');
  assert.equal(pool.options.connectionString, undefined);
});

// `pg` fills the gaps from PGHOST/PGPORT/... and its own defaults, which is
// the standard port a sidecar, service container or Cloud Run Postgres listens
// on - never the host-side mapping `pnpm db:up` publishes on a laptop.
test('the pool then dials the pg default rather than the docker-compose port', () => {
  const resolved = new pg.Client(pool.options);
  assert.equal(resolved.host, 'localhost');
  assert.equal(resolved.port, 5432);
  assert.equal(databaseTarget(), 'localhost:5432');
});

// With no connection string, a reachable Postgres can still turn the agent
// away - PGUSER/PGDATABASE absent gives 28000 "no PostgreSQL user name
// specified in startup packet", a missing password a SASL complaint with no
// code at all - and none of those errors names DATABASE_URL by itself.
test('a rejected handshake is still explained in terms of DATABASE_URL', () => {
  const startupPacket = Object.assign(
    new Error('no PostgreSQL user name specified in startup packet'),
    { code: '28000' },
  );
  const noPassword = new Error(
    'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string',
  );

  for (const err of [startupPacket, noPassword]) {
    assert.ok(isDatabaseConnectionError(err), `no hint would be printed for: ${err.message}`);
    const hint = databaseConnectionHint(err);
    assert.match(hint, /localhost:5432/);
    assert.match(hint, /DATABASE_URL is unset/);
    assert.match(hint, /PGHOST\/PGPORT\/PGUSER\/PGPASSWORD\/PGDATABASE/);
  }
});
