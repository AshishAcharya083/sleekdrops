// The note a stage leaves about what it is waiting on. It has to survive the
// awaits between chat() and the stage that started it, and it has to read as a
// sentence in the timeout message an operator gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeLlmCall,
  formatDuration,
  newLlmCallTrace,
  noteLlmCall,
  noteLlmCallEnded,
  withLlmCallTrace,
} from './callTrace.js';

const call = (overrides: Partial<Parameters<typeof noteLlmCall>[0]> = {}) => ({
  model: 'claude-opus-5',
  search: true,
  attempt: 1,
  attemptsAllowed: 3,
  startedAt: Date.now(),
  ...overrides,
});

test('a call noted deep inside the stage reaches the stage that started it', async () => {
  const trace = newLlmCallTrace();

  await withLlmCallTrace(trace, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await (async () => {
      noteLlmCall(call({ model: 'gemini-2.5-flash', search: false }));
    })();
  });

  assert.equal(trace.last?.model, 'gemini-2.5-flash');
  assert.equal(trace.last?.search, false);
});

test('the last call wins, because that is the one still in flight', async () => {
  const trace = newLlmCallTrace();
  await withLlmCallTrace(trace, async () => {
    noteLlmCall(call({ attempt: 1 }));
    noteLlmCall(call({ attempt: 2 }));
  });
  assert.equal(trace.last?.attempt, 2);
});

test('noting a call outside a stage run is a no-op, not a crash', () => {
  assert.doesNotThrow(() => noteLlmCall(call()));
});

test('a first attempt reads as itself; a retry says which one it is', () => {
  const startedAt = Date.now() - 42_000;
  assert.match(
    describeLlmCall(call({ startedAt })),
    /^claude-opus-5 with web search, still in flight after 42s$/,
  );
  assert.match(
    describeLlmCall(call({ startedAt, attempt: 3, search: false })),
    /^claude-opus-5, retry 2 of 2, still in flight after 42s$/,
  );
  assert.equal(describeLlmCall(null), '', 'no call started is its own answer');
});

test('a call that came back says so, so the hunt moves past the model', () => {
  const now = Date.now();
  const described = describeLlmCall(
    call({ startedAt: now - 700_000, endedAt: now - 600_000 }),
    now,
  );
  assert.match(described, /which answered 10m 0s ago - the stage stopped after it/);
});

test('a call is only ended once - the first answer is the one that matters', async () => {
  const trace = newLlmCallTrace();
  await withLlmCallTrace(trace, async () => {
    noteLlmCall(call());
    noteLlmCallEnded(1_000);
    noteLlmCallEnded(2_000);
  });
  assert.equal(trace.last?.endedAt, 1_000);
});

test('durations read the way an operator says them', () => {
  assert.equal(formatDuration(9), '9s');
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(3_780), '1h 3m');
});
