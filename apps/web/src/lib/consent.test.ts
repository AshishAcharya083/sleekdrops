import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConsent,
  resolveConsent,
  uniformGrants,
  CONSENT_CATEGORIES,
  POLICY_VERSION,
  type ConsentGrants,
} from './consent.ts';

/** A record as this policy version writes it. */
const record = (grants: ConsentGrants, v: number = POLICY_VERSION, ts = 1) => ({ v, grants, ts });

/** A record as policy version 1 wrote it: one status, for analytics, no categories. */
const legacy = (status: 'granted' | 'denied') => JSON.stringify({ v: 1, status, ts: 123 });

test('parseConsent reads a per-category record', () => {
  assert.deepEqual(
    parseConsent(JSON.stringify({ v: 2, grants: { analytics: 'granted', ads: 'denied' }, ts: 123 })),
    { v: 2, grants: { analytics: 'granted', ads: 'denied' }, ts: 123 },
  );
});

test('parseConsent denies a category the record does not mention', () => {
  assert.deepEqual(parseConsent(JSON.stringify({ v: 2, grants: { analytics: 'granted' }, ts: 1 })), {
    v: 2,
    grants: { analytics: 'granted', ads: 'denied' },
    ts: 1,
  });
});

test('parseConsent rejects missing, malformed, or invalid records', () => {
  assert.equal(parseConsent(null), null);
  assert.equal(parseConsent(''), null);
  assert.equal(parseConsent('not json'), null);
  assert.equal(parseConsent(JSON.stringify({ status: 'granted' })), null);
  assert.equal(parseConsent(JSON.stringify({ v: 1, status: 'maybe' })), null);
  assert.equal(parseConsent(JSON.stringify({ v: 2, grants: { ads: 'maybe' } })), null);
  assert.equal(parseConsent(JSON.stringify({ v: 2, grants: {} })), null);
  assert.equal(parseConsent(JSON.stringify({ v: 2, grants: 'granted' })), null);
});

test('parseConsent defaults a missing timestamp to 0', () => {
  assert.deepEqual(parseConsent(JSON.stringify({ v: 2, grants: uniformGrants('denied') })), {
    v: 2,
    grants: { analytics: 'denied', ads: 'denied' },
    ts: 0,
  });
});

test('a policy-1 record migrates to the equivalent per-category record', () => {
  // The single status it carries was the analytics decision; ads did not exist
  // when it was written, so it is the one thing this visitor never agreed to.
  assert.deepEqual(parseConsent(legacy('granted')), {
    v: 1,
    grants: { analytics: 'granted', ads: 'denied' },
    ts: 123,
  });
  assert.deepEqual(parseConsent(legacy('denied')), {
    v: 1,
    grants: { analytics: 'denied', ads: 'denied' },
    ts: 123,
  });
});

test('a migrated policy-1 record re-prompts instead of being read as a decision', () => {
  const stored = parseConsent(legacy('granted'));
  assert.ok(stored, 'a stored decision must survive the policy bump as a record');
  assert.deepEqual(resolveConsent(stored, false), {
    // 'policy-update', not 'banner': the visitor decided once and is being asked
    // again, which is only distinguishable because the record parsed.
    prompt: 'policy-update',
    effects: { analytics: 'pending', ads: 'pending' },
  });
});

test('a privacy signal always declines every category and shows the GPC card', () => {
  // Wins even over a stored grant of both categories.
  const stored = record(uniformGrants('granted'));
  const denied = { prompt: 'gpc', effects: { analytics: 'deny', ads: 'deny' } };
  assert.deepEqual(resolveConsent(stored, true), denied);
  assert.deepEqual(resolveConsent(null, true), denied);
  assert.deepEqual(resolveConsent(parseConsent(legacy('granted')), true), denied);
});

test('an in-date record applies each category silently and independently', () => {
  assert.deepEqual(resolveConsent(record({ analytics: 'granted', ads: 'denied' }), false), {
    prompt: 'none',
    effects: { analytics: 'grant', ads: 'deny' },
  });
  assert.deepEqual(resolveConsent(record({ analytics: 'denied', ads: 'granted' }), false), {
    prompt: 'none',
    effects: { analytics: 'deny', ads: 'grant' },
  });
  assert.deepEqual(resolveConsent(record(uniformGrants('granted')), false), {
    prompt: 'none',
    effects: { analytics: 'grant', ads: 'grant' },
  });
  assert.deepEqual(resolveConsent(record(uniformGrants('denied')), false), {
    prompt: 'none',
    effects: { analytics: 'deny', ads: 'deny' },
  });
});

test('no stored record shows the first-visit banner and holds every category', () => {
  assert.deepEqual(resolveConsent(null, false), {
    prompt: 'banner',
    effects: { analytics: 'pending', ads: 'pending' },
  });
});

test('a stale policy version re-prompts and keeps holding every category', () => {
  const stored = record(uniformGrants('granted'), POLICY_VERSION - 1);
  assert.deepEqual(resolveConsent(stored, false), {
    prompt: 'policy-update',
    effects: { analytics: 'pending', ads: 'pending' },
  });
});

test('every category the site declares is resolved, none left undefined', () => {
  // Guards the next category added to CONSENT_CATEGORIES: a resolution missing an
  // effect reads as `undefined` at the call site, which is neither grant nor deny.
  const { effects } = resolveConsent(null, false);
  assert.deepEqual(Object.keys(effects).sort(), [...CONSENT_CATEGORIES].sort());
  assert.deepEqual(Object.keys(uniformGrants('denied')).sort(), [...CONSENT_CATEGORIES].sort());
});
