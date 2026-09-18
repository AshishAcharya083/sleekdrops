// The other half of the readiness contract: a rejected password is a
// misconfiguration, not a database that is still starting, so it must surface
// on the first attempt. Retrying it would hide the real fault behind half a
// minute of silence and then report the wrong cause.
//
// Needs a live server (the credentials have to be rejected by a real one), so
// this skips itself when no DATABASE_URL answers - same as the other .db tests.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const live = process.env.DATABASE_URL ?? '';
const wrongPassword = withWrongPassword(live);
if (wrongPassword) process.env.DATABASE_URL = wrongPassword;

const { pgErrorCode, pool, waitForDatabase } = await import('./pool.js');

/** The live DSN with its password replaced, keeping host, port and database. */
function withWrongPassword(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = 'definitely-not-the-password';
    return parsed.toString();
  } catch {
    return '';
  }
}

// 28P01 (invalid_password) proves both halves of the setup at once: a server is
// listening, and it did reject these credentials.
const probe = wrongPassword
  ? await pool
      .query('SELECT 1')
      .then(() => 'connected')
      .catch((err) => pgErrorCode(err) ?? 'unknown')
  : 'no DATABASE_URL';
const skip =
  probe === '28P01'
    ? false
    : `no DATABASE_URL naming a password-checking Postgres (${probe}) - start one to run this`;

after(async () => {
  await pool.end();
});

test('fails an authentication error immediately instead of retrying it', { skip }, async () => {
  const started = Date.now();
  await assert.rejects(
    () => waitForDatabase(30, 1_000),
    (err: unknown) => pgErrorCode(err) === '28P01',
  );
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 1_000, `an auth failure must not be retried, took ${elapsedMs}ms`);
});
