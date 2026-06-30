import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  errorEventToProps,
  rejectionToProps,
  errorSignature,
  ErrorDeduper,
  STACK_LIMIT,
  DEDUPE_WINDOW_MS,
  DEDUPE_MAX_KEYS,
} from './error-capture.ts';

test('errorEventToProps shapes an uncaught error into the $client_error payload', () => {
  const error = new Error('x is not a function');
  error.stack = 'Error: x is not a function\n  at f (app.js:12:8)';
  const props = errorEventToProps({
    message: 'Uncaught TypeError: x is not a function',
    filename: 'https://sleekdrops.com/app.js',
    lineno: 12,
    colno: 8,
    error,
  } as ErrorEvent);

  assert.deepEqual(props, {
    message: 'Uncaught TypeError: x is not a function',
    source: 'https://sleekdrops.com/app.js',
    lineno: 12,
    colno: 8,
    stack: 'Error: x is not a function\n  at f (app.js:12:8)',
  });
});

test('errorEventToProps falls back when fields are missing and has no stack for a non-Error', () => {
  const props = errorEventToProps({
    message: '',
    filename: '',
    lineno: 0,
    colno: 0,
    error: 'just a string',
  } as unknown as ErrorEvent);

  assert.deepEqual(props, {
    message: 'Unknown error',
    source: undefined,
    lineno: undefined,
    colno: undefined,
    stack: undefined,
  });
});

test('errorEventToProps truncates an oversized stack to STACK_LIMIT', () => {
  const error = new Error('boom');
  error.stack = 'x'.repeat(STACK_LIMIT + 500);
  const props = errorEventToProps({
    message: 'boom',
    filename: 'app.js',
    lineno: 1,
    colno: 1,
    error,
  } as ErrorEvent);

  assert.equal(props.stack?.length, STACK_LIMIT);
});

test('rejectionToProps reads the message and stack from an Error reason', () => {
  const reason = new Error('promise blew up');
  reason.stack = 'Error: promise blew up\n  at g (app.js:3:1)';
  const props = rejectionToProps({ reason } as PromiseRejectionEvent);

  assert.deepEqual(props, {
    message: 'promise blew up',
    handled: false,
    stack: 'Error: promise blew up\n  at g (app.js:3:1)',
  });
});

test('rejectionToProps handles string and non-string non-Error reasons', () => {
  assert.deepEqual(rejectionToProps({ reason: 'string reason' } as PromiseRejectionEvent), {
    message: 'string reason',
    handled: false,
    stack: undefined,
  });
  assert.deepEqual(rejectionToProps({ reason: { code: 42 } } as PromiseRejectionEvent), {
    message: 'Unhandled promise rejection',
    handled: false,
    stack: undefined,
  });
});

test('errorSignature combines message, source, and line for de-duplication', () => {
  assert.equal(
    errorSignature({ message: 'boom', source: 'app.js', lineno: 12 }),
    'boom|app.js|12',
  );
  assert.equal(errorSignature({ message: 'boom' }), 'boom||');
});

test('ErrorDeduper suppresses an identical error inside the dedupe window', () => {
  const deduper = new ErrorDeduper();
  const sig = 'boom|app.js|12';

  assert.equal(deduper.shouldReport(sig, 1_000), true);
  assert.equal(deduper.shouldReport(sig, 1_000 + DEDUPE_WINDOW_MS - 1), false);
  assert.equal(deduper.shouldReport(sig, 1_000 + DEDUPE_WINDOW_MS), true);
});

test('ErrorDeduper tracks distinct signatures independently', () => {
  const deduper = new ErrorDeduper();
  assert.equal(deduper.shouldReport('a', 0), true);
  assert.equal(deduper.shouldReport('b', 0), true);
  assert.equal(deduper.shouldReport('a', 1), false);
  assert.equal(deduper.shouldReport('b', 1), false);
});

test('ErrorDeduper clears its map once it hits DEDUPE_MAX_KEYS, staying bounded', () => {
  const deduper = new ErrorDeduper();
  for (let i = 0; i < DEDUPE_MAX_KEYS; i++) {
    assert.equal(deduper.shouldReport(`sig-${i}`, 0), true);
  }
  // The next new signature trips the cap and clears the map, so an earlier
  // signature is treated as fresh again rather than the map growing unbounded.
  assert.equal(deduper.shouldReport('sig-overflow', 1), true);
  assert.equal(deduper.shouldReport('sig-0', 2), true);
});
