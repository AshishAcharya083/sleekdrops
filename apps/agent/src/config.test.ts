// Where the pool dials, resolved from one environment at a time. The v0.14.0
// boot crash lived here: the docker-compose DSN was the unconditional default,
// so every deployed instance dialled host port 5544 - a mapping that only
// exists on a developer laptop - and died on ECONNREFUSED before the API,
// worker and scheduler had started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MISSING_DATABASE_URL, resolveDatabase } from './config.js';

const PLATFORM_VARS = {
  PGHOST: 'db.internal',
  PGPORT: '5432',
  PGUSER: 'app',
  PGPASSWORD: 's3cret',
  PGDATABASE: 'app',
};

test('an explicit DATABASE_URL wins over injected PG* vars', () => {
  const { url } = resolveDatabase({
    ...PLATFORM_VARS,
    DATABASE_URL: 'postgres://deploy:pw@primary.example:6432/agent',
  });
  assert.equal(url, 'postgres://deploy:pw@primary.example:6432/agent');
});

test('assembles the DSN from the PG* vars a container platform injects', () => {
  const { url, label } = resolveDatabase({ ...PLATFORM_VARS, NODE_ENV: 'production' });
  assert.equal(url, 'postgres://app:s3cret@db.internal:5432/app');
  assert.equal(label, 'db.internal:5432/app');
});

test('defaults the assembled port to 5432 when PGPORT is not injected', () => {
  const { url } = resolveDatabase({ ...PLATFORM_VARS, PGPORT: undefined });
  assert.equal(url, 'postgres://app:s3cret@db.internal:5432/app');
});

test('percent-encodes credentials so a punctuated password still parses', () => {
  const { url } = resolveDatabase({ ...PLATFORM_VARS, PGPASSWORD: 'p@ss/w:rd?#' });
  const parsed = new URL(url);
  assert.equal(decodeURIComponent(parsed.password), 'p@ss/w:rd?#');
  assert.equal(parsed.hostname, 'db.internal');
  assert.equal(parsed.pathname, '/app');
});

test('ignores a partial PG* set rather than assembling half a target', () => {
  const { url, label } = resolveDatabase({
    ...PLATFORM_VARS,
    PGDATABASE: undefined,
    NODE_ENV: 'production',
  });
  assert.equal(url, '');
  assert.equal(label, '(unset)');
});

test('production with nothing configured resolves no target at all', () => {
  // The regression guard: no DSN beats a guessed one, because the entrypoint
  // can report "DATABASE_URL is not set" instead of an ECONNREFUSED stack.
  const { url } = resolveDatabase({ NODE_ENV: 'production' });
  assert.equal(url, '');
});

test('an empty DATABASE_URL counts as unset, as dotenv leaves blank keys', () => {
  const { url } = resolveDatabase({ DATABASE_URL: '', NODE_ENV: 'production' });
  assert.equal(url, '');
});

test('falls back to the docker-compose DSN only outside production', () => {
  for (const NODE_ENV of [undefined, 'development', 'test']) {
    const { url, label } = resolveDatabase({ NODE_ENV });
    assert.equal(url, 'postgres://sleekdrops:sleekdrops@localhost:5544/sleekdrops_agent');
    assert.equal(label, 'localhost:5544/sleekdrops_agent');
  }
});

test('the log label keeps the credentials out of the logs', () => {
  const { label } = resolveDatabase({
    DATABASE_URL: 'postgres://deploy:top-secret@primary.example:6432/agent',
  });
  assert.equal(label, 'primary.example:6432/agent');
  assert.equal(label.includes('top-secret'), false);
  assert.equal(label.includes('deploy'), false);
});

test('labels a libpq key=value connection string without pretending to parse it', () => {
  // Passed through to pg verbatim: only the log line degrades.
  const { url, label } = resolveDatabase({ DATABASE_URL: 'host=db.internal dbname=app' });
  assert.equal(url, 'host=db.internal dbname=app');
  assert.equal(label, '(unparsable connection string)');
});

test('routes a socket-directory PGHOST through the host parameter', () => {
  // Cloud SQL on Cloud Run injects PGHOST=/cloudsql/<instance>; a path cannot
  // sit in a URL authority, and pg reads it from `host` instead.
  const { url, label } = resolveDatabase({
    ...PLATFORM_VARS,
    PGHOST: '/cloudsql/sleekdrops:us-central1:agent',
  });
  assert.equal(
    url,
    'postgres://app:s3cret@/app?host=%2Fcloudsql%2Fsleekdrops%3Aus-central1%3Aagent&port=5432',
  );
  assert.equal(label, '/cloudsql/sleekdrops:us-central1:agent:5432/app');
});

test('names DATABASE_URL in the message both entrypoints print', () => {
  // index.ts and `pnpm migrate` share it, so the variable a developer has to
  // set is the first thing the line says.
  assert.match(MISSING_DATABASE_URL, /^DATABASE_URL is not set/);
  assert.match(MISSING_DATABASE_URL, /PGHOST/);
});
