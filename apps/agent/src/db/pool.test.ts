// Boot must survive a database that is not there yet, and must NOT wait on one
// that will never answer differently. DATABASE_URL is set before the pool is
// imported, because the pool binds its target once at module load.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Port 1 is privileged and unbound: connecting to it always refuses at once.
process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const {
  databaseConnectionHint,
  databaseTarget,
  isDatabaseConnectionError,
  isDatabaseUnreachableError,
  isTransientConnectionError,
  pool,
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
  assert.ok(isTransientConnectionError({ code: 'ENETUNREACH' }));
  assert.ok(isTransientConnectionError(new Error('the database system is starting up')));

  assert.ok(!isTransientConnectionError({ code: '28P01' })); // invalid_password
  assert.ok(!isTransientConnectionError({ code: '3D000' })); // invalid_catalog_name
  assert.ok(!isTransientConnectionError(new Error('relation "topics" does not exist')));
  assert.ok(!isTransientConnectionError(undefined));

  assert.ok(isDatabaseUnreachableError({ code: 'ENOTFOUND' }));
  assert.ok(!isDatabaseUnreachableError({ code: '57P03' }));
});

// A host that resolves to several addresses - any dual-stack `localhost`, which
// is what both .env.example and the `pg` default use - fails as an
// AggregateError whose own code is only the FIRST attempt's. In a container
// without usable IPv6 that is EADDRNOTAVAIL for `::1`, and judging by it alone
// would neither retry a late Postgres nor print the hint below.
test('a multi-address connect failure is judged by every attempt it bundles', () => {
  const dualStack = new AggregateError(
    [
      Object.assign(new Error('connect EADDRNOTAVAIL ::1:5432'), { code: 'EADDRNOTAVAIL' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    ],
    'All attempts to connect failed',
  );
  Object.assign(dualStack, { code: 'EADDRNOTAVAIL' });

  assert.ok(isTransientConnectionError(dualStack), 'a late Postgres behind IPv6 is not waited for');
  assert.ok(isDatabaseUnreachableError(dualStack), 'the operator gets no hint about DATABASE_URL');

  // Bundling does not make a permanent failure transient.
  const credentials = new AggregateError(
    [Object.assign(new Error('password authentication failed'), { code: '28P01' })],
    'All attempts to connect failed',
  );
  assert.ok(!isTransientConnectionError(credentials));
});

// Being turned away by a Postgres that answered is a connection failure too,
// and the one an unset DATABASE_URL produces: `pg` then builds the startup
// packet from PG* and the server rejects it. None of those errors mentions
// DATABASE_URL, so without this they reach the operator unexplained.
test('a refused handshake counts as a connection failure, a failed query does not', () => {
  assert.ok(isDatabaseConnectionError({ code: 'ECONNREFUSED' }));
  assert.ok(isDatabaseConnectionError({ code: '28000' })); // no user name in startup packet
  assert.ok(isDatabaseConnectionError({ code: '28P01' })); // password authentication failed
  assert.ok(isDatabaseConnectionError({ code: '3D000' })); // database does not exist
  assert.ok(isDatabaseConnectionError({ code: '08006' })); // connection failure
  assert.ok(isDatabaseConnectionError(new Error('SASL: client password must be a string')));

  assert.ok(!isDatabaseConnectionError({ code: '42P01' })); // undefined_table
  assert.ok(!isDatabaseConnectionError(new TypeError('stage is not a function')));
  assert.ok(!isDatabaseConnectionError(undefined));
});

// Both entrypoints print this when a connection cannot be opened - it is the
// whole operator experience of a misconfigured deployment, so it has to stay
// actionable: where we dialed, what sets it, and what to do about it.
test('the fatal hint names the dialed target and what to set', () => {
  const unreachable = databaseConnectionHint({ code: 'ECONNREFUSED' });
  assert.match(unreachable, /no Postgres answering at 127\.0\.0\.1:1/);
  assert.match(unreachable, /DATABASE_URL/);
  assert.match(unreachable, /5544/);

  // A server that answered and said no names the same target and variable.
  const refused = databaseConnectionHint({ code: '28P01' });
  assert.match(refused, /cannot open a database connection to 127\.0\.0\.1:1/);
  assert.match(refused, /that target comes from DATABASE_URL/);
});
