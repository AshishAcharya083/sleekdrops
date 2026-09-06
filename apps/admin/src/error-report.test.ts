import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEDUPE_MAX_KEYS,
  DEDUPE_WINDOW_MS,
  ErrorDeduper,
  errorSignature,
} from './error-report.ts';

test('the signature separates failures by source, route and status', () => {
  const message = 'HTTP 500';
  const base = { source: 'api', route: '/api/topics', http_status: 500 };
  assert.equal(errorSignature(message, base), errorSignature(message, { ...base }));
  assert.notEqual(errorSignature(message, base), errorSignature(message, { ...base, route: '/api/articles' }));
  assert.notEqual(errorSignature(message, base), errorSignature(message, { ...base, http_status: 401 }));
  assert.notEqual(errorSignature(message, base), errorSignature(message, { ...base, source: 'window_error' }));
  assert.notEqual(errorSignature(message, base), errorSignature('HTTP 404', base));
});

test('the signature tolerates missing attributes', () => {
  assert.equal(errorSignature('boom'), 'boom|||');
});

test('the 4s poll loop against an unreachable API reports once per window', () => {
  const deduper = new ErrorDeduper();
  const signature = errorSignature('Failed to fetch', { source: 'api', route: '/api/overview' });
  const reported = [0, 4_000, 8_000, 12_000, 16_000, 20_000].filter((at) =>
    deduper.shouldReport(signature, at),
  );
  assert.deepEqual(reported, [0, 12_000]);
});

test('a different failure still gets through inside the window', () => {
  const deduper = new ErrorDeduper();
  assert.equal(deduper.shouldReport(errorSignature('a', { route: '/api/topics' }), 0), true);
  assert.equal(deduper.shouldReport(errorSignature('a', { route: '/api/articles' }), 1), true);
});

test('the same signature is admitted again once the window has passed', () => {
  const deduper = new ErrorDeduper();
  assert.equal(deduper.shouldReport('sig', 0), true);
  assert.equal(deduper.shouldReport('sig', DEDUPE_WINDOW_MS - 1), false);
  assert.equal(deduper.shouldReport('sig', DEDUPE_WINDOW_MS), true);
});

test('the signature map cannot grow unbounded', () => {
  const deduper = new ErrorDeduper();
  for (let i = 0; i <= DEDUPE_MAX_KEYS + 10; i++) {
    assert.equal(deduper.shouldReport(`sig-${i}`, i), true);
  }
  // The map was cleared on reaching the cap, so an early signature is fresh
  // again rather than being remembered forever.
  assert.equal(deduper.shouldReport('sig-0', DEDUPE_MAX_KEYS + 11), true);
});
