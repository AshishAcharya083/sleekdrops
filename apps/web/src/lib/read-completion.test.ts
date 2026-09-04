import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActiveTime,
  ReadCompletionGate,
  READ_ACTIVE_MS,
  activeTimeBucket,
} from './read-completion.ts';
import { scrub } from './pii.ts';

const T0 = 1_700_000_000_000;

test('active time is bucketed at 15 and 60 seconds', () => {
  assert.equal(activeTimeBucket(0), '0-15s');
  assert.equal(activeTimeBucket(14_999), '0-15s');
  assert.equal(activeTimeBucket(15_000), '15-60s');
  assert.equal(activeTimeBucket(59_999), '15-60s');
  assert.equal(activeTimeBucket(60_000), '60s+');
  assert.equal(activeTimeBucket(3_600_000), '60s+');
});

test('a nonsense elapsed value still lands in a bucket rather than reporting nothing', () => {
  assert.equal(activeTimeBucket(-1), '0-15s');
  assert.equal(activeTimeBucket(Number.NaN), '0-15s');
});

test('the stopwatch counts only the time the tab was in front of the reader', () => {
  const active = new ActiveTime(T0);
  assert.equal(active.elapsed(T0 + 5_000), 5_000);
  active.pause(T0 + 5_000);
  // An hour in a background tab must add nothing.
  assert.equal(active.elapsed(T0 + 3_605_000), 5_000);
  active.resume(T0 + 3_605_000);
  assert.equal(active.elapsed(T0 + 3_615_000), 15_000);
});

test('a repeated pause or resume does not double-count or lose time', () => {
  const active = new ActiveTime(T0);
  active.pause(T0 + 1_000);
  active.pause(T0 + 9_000);
  assert.equal(active.elapsed(T0 + 9_000), 1_000);
  active.resume(T0 + 9_000);
  active.resume(T0 + 12_000);
  assert.equal(active.elapsed(T0 + 12_000), 4_000);
});

test('a document that opens hidden accrues nothing until it is looked at', () => {
  const active = new ActiveTime(T0);
  active.pause(T0);
  assert.equal(active.elapsed(T0 + 60_000), 0);
});

test('reaching the end is not enough - the reader has to have spent time there', () => {
  const gate = new ReadCompletionGate();
  gate.reachEnd();
  assert.equal(gate.shouldEmit(READ_ACTIVE_MS - 1), false);
  assert.equal(gate.shouldEmit(READ_ACTIVE_MS), true);
});

test('time alone is not enough either - a tab left open is not a read', () => {
  const gate = new ReadCompletionGate();
  assert.equal(gate.shouldEmit(3_600_000), false);
  gate.reachEnd();
  assert.equal(gate.shouldEmit(3_600_000), true);
});

test('the gate opens exactly once, however often it is re-checked', () => {
  const gate = new ReadCompletionGate();
  gate.reachEnd();
  const outcomes = [0, 1, 2, 3].map(() => gate.shouldEmit(READ_ACTIVE_MS * 2));
  assert.deepEqual(outcomes, [true, false, false, false]);
});

test('the read payload survives the scrub chokepoint unchanged', () => {
  const props = { screen: 'blog-post', slug: 'sony-wh-1000xm6', active_time: '60s+' };
  assert.deepEqual(scrub(props), props);
});
