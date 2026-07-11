import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConsent, resolveConsent, POLICY_VERSION } from './consent.ts';

test('parseConsent reads a valid record', () => {
  assert.deepEqual(
    parseConsent(JSON.stringify({ v: 1, status: 'granted', ts: 123 })),
    { v: 1, status: 'granted', ts: 123 },
  );
});

test('parseConsent rejects missing, malformed, or invalid records', () => {
  assert.equal(parseConsent(null), null);
  assert.equal(parseConsent(''), null);
  assert.equal(parseConsent('not json'), null);
  assert.equal(parseConsent(JSON.stringify({ status: 'granted' })), null);
  assert.equal(parseConsent(JSON.stringify({ v: 1, status: 'maybe' })), null);
});

test('parseConsent defaults a missing timestamp to 0', () => {
  assert.deepEqual(parseConsent(JSON.stringify({ v: 1, status: 'denied' })), {
    v: 1,
    status: 'denied',
    ts: 0,
  });
});

test('a privacy signal always declines and shows the GPC card', () => {
  // Wins even over a stored grant.
  const stored = { v: POLICY_VERSION, status: 'granted' as const, ts: 1 };
  assert.deepEqual(resolveConsent(stored, true), { prompt: 'gpc', effect: 'deny' });
  assert.deepEqual(resolveConsent(null, true), { prompt: 'gpc', effect: 'deny' });
});

test('an in-date grant applies silently', () => {
  const stored = { v: POLICY_VERSION, status: 'granted' as const, ts: 1 };
  assert.deepEqual(resolveConsent(stored, false), { prompt: 'none', effect: 'grant' });
});

test('an in-date denial applies silently', () => {
  const stored = { v: POLICY_VERSION, status: 'denied' as const, ts: 1 };
  assert.deepEqual(resolveConsent(stored, false), { prompt: 'none', effect: 'deny' });
});

test('no stored record shows the first-visit banner and buffers', () => {
  assert.deepEqual(resolveConsent(null, false), { prompt: 'banner', effect: 'pending' });
});

test('a stale policy version re-prompts and keeps buffering', () => {
  const stored = { v: POLICY_VERSION - 1, status: 'granted' as const, ts: 1 };
  assert.deepEqual(resolveConsent(stored, false), {
    prompt: 'policy-update',
    effect: 'pending',
  });
});
