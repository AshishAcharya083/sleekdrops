// The readiness wait's retry loop, driven the way the entrypoint drives it: the
// DSN comes from the process environment before the pool module loads.
//
// Port 1 is privileged and unbound, so connect() is refused immediately and the
// only thing pacing the loop is the delay we pass.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:not-in-logs@127.0.0.1:1/unreachable';

const { pgErrorCode, pool, waitForDatabase } = await import('./pool.js');

after(async () => {
  await pool.end();
});

/** Drive one readiness wait, collecting the retry warnings it wrote. */
async function readinessWait(
  attempts: number,
  delayMs: number,
): Promise<{ error: unknown; warnings: string[]; elapsedMs: number }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: unknown) => warnings.push(String(line));
  const started = Date.now();
  try {
    await waitForDatabase(attempts, delayMs);
    return { error: undefined, warnings, elapsedMs: Date.now() - started };
  } catch (error) {
    return { error, warnings, elapsedMs: Date.now() - started };
  } finally {
    console.warn = original;
  }
}

test('retries a refused connection up to the attempt budget, then fails', async () => {
  const { error, warnings, elapsedMs } = await readinessWait(3, 20);
  assert.equal(pgErrorCode(error), 'ECONNREFUSED');
  assert.equal(warnings.length, 2, 'attempts 1 and 2 retry, attempt 3 gives up');
  assert.ok(elapsedMs >= 30, `should have waited between attempts, took ${elapsedMs}ms`);
});

test('names the target and the attempt in every retry warning', async () => {
  const { warnings } = await readinessWait(2, 1);
  assert.equal(
    warnings[0],
    '[db] 127.0.0.1:1/unreachable not ready (ECONNREFUSED) - attempt 1/2, retrying in 1ms',
  );
});

test('keeps the DSN credentials out of the retry warnings', async () => {
  const { warnings } = await readinessWait(2, 1);
  assert.equal(
    warnings.some((line) => line.includes('not-in-logs')),
    false,
  );
});

test('a single attempt reports the refusal at once instead of sleeping', async () => {
  const { error, warnings, elapsedMs } = await readinessWait(1, 30_000);
  assert.equal(pgErrorCode(error), 'ECONNREFUSED');
  assert.deepEqual(warnings, []);
  assert.ok(elapsedMs < 1_000, `should not have slept, took ${elapsedMs}ms`);
});
