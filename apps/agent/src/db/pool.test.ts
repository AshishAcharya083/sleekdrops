// Boot must survive a database that is not there yet, and must NOT wait on one
// that will never answer differently. DATABASE_URL is set before the pool is
// imported, because the pool binds its target once at module load.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Port 1 is privileged and unbound: connecting to it always refuses at once.
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const {
  databaseTarget,
  isDatabaseUnreachableError,
  isTransientConnectionError,
  pool,
  unreachableDatabaseHint,
  waitForDatabase,
} = await import('./pool.js');

after(async () => {
  await pool.end();
});

test('waitForDatabase retries an absent server, then rethrows the connection error', async () => {
  const startedAt = Date.now();
  await assert.rejects(waitForDatabase(1_500), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, 'ECONNREFUSED');
    return true;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1_000, `gave up after ${elapsed}ms without using the retry window`);
  assert.ok(elapsed < 6_000, `overran the retry window by far (${elapsed}ms)`);
});

test('databaseTarget names the host:port the pool dials', () => {
  assert.equal(databaseTarget(), '127.0.0.1:1');
});

test('connection-level failures are transient, misconfiguration is not', () => {
  assert.ok(isTransientConnectionError({ code: 'ECONNREFUSED' }));
  assert.ok(isTransientConnectionError({ code: 'ENOTFOUND' }));
  assert.ok(isTransientConnectionError({ code: 'ECONNRESET' }));
  assert.ok(isTransientConnectionError({ code: '57P03' }));
  assert.ok(isTransientConnectionError(new Error('the database system is starting up')));

  assert.ok(!isTransientConnectionError({ code: '28P01' })); // invalid_password
  assert.ok(!isTransientConnectionError({ code: '3D000' })); // invalid_catalog_name
  assert.ok(!isTransientConnectionError(new Error('relation "topics" does not exist')));
  assert.ok(!isTransientConnectionError(undefined));

  assert.ok(isDatabaseUnreachableError({ code: 'ENOTFOUND' }));
  assert.ok(!isDatabaseUnreachableError({ code: '57P03' }));
});

// Both entrypoints print this when nothing answers - it is the whole operator
// experience of a misconfigured deployment, so it has to stay actionable.
test('the fatal hint names the dialed target and what to set', () => {
  const hint = unreachableDatabaseHint();
  assert.match(hint, /127\.0\.0\.1:1/);
  assert.match(hint, /DATABASE_URL/);
  assert.match(hint, /5544/);
});
