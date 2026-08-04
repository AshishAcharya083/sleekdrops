import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTraceId, resolveTraceId } from './trace.js';

const generate = () => 'generated-trace-id';

test('adopts the trace id the panel sent', () => {
  assert.equal(resolveTraceId('0199b3e7c2f97c9aa4b1d2e3f4a5b6c7', generate), '0199b3e7c2f97c9aa4b1d2e3f4a5b6c7');
});

test('accepts a dashed uuid, which is what a hand-written client tends to send', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.equal(resolveTraceId(uuid, generate), uuid);
});

test('generates an id when the header is absent or blank', () => {
  assert.equal(resolveTraceId(undefined, generate), 'generated-trace-id');
  assert.equal(resolveTraceId('', generate), 'generated-trace-id');
  assert.equal(resolveTraceId('   ', generate), 'generated-trace-id');
});

test('trims surrounding whitespace rather than rejecting the id', () => {
  assert.equal(resolveTraceId('  abcd1234efgh  ', generate), 'abcd1234efgh');
});

test('rejects ids that could poison a log line or a response header', () => {
  for (const hostile of [
    'abc"}\n{"level":"error"',
    'trace id with spaces',
    'trace\r\nX-Injected: 1',
    '../../etc/passwd',
    'short',
    'x'.repeat(65),
  ]) {
    assert.equal(resolveTraceId(hostile, generate), 'generated-trace-id', hostile);
  }
});

test('generated ids are 32 hex characters and unique per call', () => {
  const first = generateTraceId();
  const second = generateTraceId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
  assert.equal(resolveTraceId(first), first, 'a generated id must itself be acceptable');
});
