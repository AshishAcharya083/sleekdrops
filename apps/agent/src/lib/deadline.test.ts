// A deadline that only aborts is the bug this helper exists for, so the case
// that matters is the one where the work never settles at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withDeadline } from './deadline.js';

const never = () => new Promise<string>(() => {});

test('work that never settles rejects with the error the expiry built', async () => {
  await assert.rejects(
    withDeadline(10, never, () => new Error('stopped after 10ms')),
    /stopped after 10ms/,
  );
});

test('the expiry runs its cleanup on the timeout path', async () => {
  let cleanedUp = false;
  await assert.rejects(
    withDeadline(10, never, () => {
      cleanedUp = true;
      return new Error('stopped');
    }),
    /stopped/,
  );
  assert.equal(cleanedUp, true);
});

test('work that finishes in time returns its value and never expires', async () => {
  let expired = false;
  const value = await withDeadline(
    1_000,
    async () => 'done',
    () => {
      expired = true;
      return new Error('should not happen');
    },
  );
  assert.equal(value, 'done');
  assert.equal(expired, false);
});

test('work that fails in time rejects with its own failure, not a timeout', async () => {
  await assert.rejects(
    withDeadline(
      1_000,
      async () => {
        throw new Error('the stage said no');
      },
      () => new Error('should not happen'),
    ),
    /the stage said no/,
  );
});

test('a rejection arriving after the deadline is not an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      withDeadline(
        10,
        () =>
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error('the abandoned call, much later')), 40);
          }),
        () => new Error('stopped'),
      ),
      /stopped/,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('cleanup that throws still produces a rejection rather than a crash', async () => {
  await assert.rejects(
    withDeadline(10, never, () => {
      throw new Error('the cleanup itself failed');
    }),
    /the cleanup itself failed/,
  );
});
