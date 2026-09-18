// The boot-time database wait, with a real refused connection: DATABASE_URL
// points at a closed port on purpose, so the ECONNREFUSED the retry keys off
// comes out of pg rather than out of a stub. The delays are shrunk to
// milliseconds; boot.db.test.ts drives the same code at the process boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const { DEFAULT_WAIT_POLICY, migrateWhenReady } = await import('./boot.js');
const { describeTarget } = await import('./pool.js');

/** Run `fn`, collecting the lines it logs to stdout. */
async function withLoggedLines(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('describeTarget names the connection string target without its password', () => {
  assert.equal(describeTarget(), '127.0.0.1:1/unreachable');
  assert.doesNotMatch(describeTarget(), /unused/);
});

test('a refused connection is retried, logging the address it is waiting for', async () => {
  let failure: unknown;
  const lines = await withLoggedLines(async () => {
    failure = await migrateWhenReady({ firstDelayMs: 10, maxDelayMs: 20, budgetMs: 60 }).then(
      () => null,
      (err: unknown) => err,
    );
  });

  // 10 + 20 + 20 = 50ms waited; a fourth 20ms sleep would break the 60ms
  // budget, so the fourth attempt is the one that gives up.
  assert.deepEqual(lines, [
    '[agent] waiting for postgres at 127.0.0.1:1/unreachable (attempt 1)',
    '[agent] waiting for postgres at 127.0.0.1:1/unreachable (attempt 2)',
    '[agent] waiting for postgres at 127.0.0.1:1/unreachable (attempt 3)',
  ]);
  assert.ok(failure instanceof Error, 'an exhausted budget still fails boot');
  assert.match(failure.message, /postgres at 127\.0\.0\.1:1\/unreachable did not answer/);
  assert.match(failure.message, /after 4 attempts/);
  assert.match(failure.message, /DATABASE_URL/);
  assert.match(failure.message, /PGHOST\/PGPORT/);
  assert.match(failure.message, /5432/);
  assert.equal((failure.cause as { code?: string }).code, 'ECONNREFUSED');
});

test('the default policy waits about a minute for a container to catch up', () => {
  const { firstDelayMs, maxDelayMs, budgetMs } = DEFAULT_WAIT_POLICY;
  let waited = 0;
  let delay = firstDelayMs;
  let attempts = 0;
  while (waited + delay <= budgetMs) {
    waited += delay;
    delay = Math.min(delay * 2, maxDelayMs);
    attempts += 1;
  }
  assert.equal(attempts, 8);
  assert.equal(waited, 55_000);
});
