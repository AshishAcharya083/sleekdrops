import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTraceId, formatLogLine, runWithTrace } from './log.js';

const TIMESTAMP = '2026-08-04T10:00:00.000Z';

test('formats one JSON line with level, time, scope and message', () => {
  const line = formatLogLine('info', 'api', 'request', undefined, undefined, TIMESTAMP);
  assert.deepEqual(JSON.parse(line), {
    level: 'info',
    time: TIMESTAMP,
    scope: 'api',
    message: 'request',
  });
});

test('includes the trace id when one is in scope', () => {
  const line = formatLogLine('info', 'api', 'request', undefined, 'abc123def456', TIMESTAMP);
  assert.equal(JSON.parse(line).trace_id, 'abc123def456');
});

test('omits the trace id key entirely when there is none', () => {
  const line = formatLogLine('warn', 'api', 'no trace', undefined, '', TIMESTAMP);
  assert.equal('trace_id' in JSON.parse(line), false);
});

test('merges structured fields and drops undefined ones', () => {
  const line = formatLogLine(
    'info',
    'api',
    'article queued from topic approval',
    { topic_id: 't-1', article_id: 'a-1', status: undefined, duration_ms: 12 },
    'trace-1',
    TIMESTAMP,
  );
  assert.deepEqual(JSON.parse(line), {
    level: 'info',
    time: TIMESTAMP,
    scope: 'api',
    message: 'article queued from topic approval',
    trace_id: 'trace-1',
    topic_id: 't-1',
    article_id: 'a-1',
    duration_ms: 12,
  });
});

test('renders an Error field as its message, so a line stays one line', () => {
  const line = formatLogLine('error', 'api', 'boom', { error: new Error('db down') }, undefined, TIMESTAMP);
  assert.equal(JSON.parse(line).error, 'db down');
  assert.equal(line.includes('\n'), false);
});

test('the line is always valid JSON even with quotes and newlines in the message', () => {
  const line = formatLogLine('error', 'api', 'a "quoted"\nmessage', undefined, undefined, TIMESTAMP);
  assert.equal(JSON.parse(line).message, 'a "quoted"\nmessage');
  assert.equal(line.includes('\n'), false);
});

test('a field cannot clobber the line keys the correlation depends on', () => {
  const line = formatLogLine(
    'info',
    'api',
    'request',
    { trace_id: 'spoofed', message: 'spoofed', level: 'debug', article_id: 'a-1' },
    'real-trace',
    TIMESTAMP,
  );
  assert.deepEqual(JSON.parse(line), {
    level: 'info',
    time: TIMESTAMP,
    scope: 'api',
    message: 'request',
    trace_id: 'real-trace',
    article_id: 'a-1',
  });
});

test('an unserialisable field degrades the line instead of throwing', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const line = formatLogLine('error', 'api', 'boom', { circular, huge: 1n }, 'trace-1', TIMESTAMP);
  assert.deepEqual(JSON.parse(line), {
    level: 'error',
    time: TIMESTAMP,
    scope: 'api',
    message: 'boom',
    trace_id: 'trace-1',
    circular: '[unserialisable]',
    huge: '[unserialisable]',
  });
});

test('runWithTrace scopes the trace id to the callback, including across awaits', async () => {
  assert.equal(currentTraceId(), undefined);
  await runWithTrace('trace-a', async () => {
    assert.equal(currentTraceId(), 'trace-a');
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(currentTraceId(), 'trace-a');
  });
  assert.equal(currentTraceId(), undefined);
});

test('concurrent requests keep their own trace id', async () => {
  const seen: string[] = [];
  const request = (id: string, delayMs: number) =>
    runWithTrace(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      seen.push(currentTraceId() ?? 'none');
    });
  await Promise.all([request('trace-slow', 5), request('trace-fast', 1)]);
  assert.deepEqual(seen, ['trace-fast', 'trace-slow']);
});
