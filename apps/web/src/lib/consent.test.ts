import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConsent,
  resolveConsent,
  uniformGrants,
  CONSENT_CATEGORIES,
  DEFAULT_GRANTS,
  POLICY_VERSION,
  type ConsentGrants,
} from './consent.ts';

/** A record as this policy version writes it. */
const record = (grants: ConsentGrants, v: number = POLICY_VERSION, ts = 1) => ({ v, grants, ts });

/** A record as policy version 1 wrote it: one status, for analytics, no categories. */
const legacy = (status: 'granted' | 'denied') => JSON.stringify({ v: 1, status, ts: 123 });

test('the site default is anonymous analytics on, advertising off', () => {
  assert.deepEqual(DEFAULT_GRANTS, { analytics: 'granted', ads: 'denied' });
});

test('parseConsent reads a per-category record', () => {
  assert.deepEqual(
    parseConsent(JSON.stringify({ v: 2, grants: { analytics: 'granted', ads: 'denied' }, ts: 123 })),
    { v: 2, grants: { analytics: 'granted', ads: 'denied' }, ts: 123 },
  );
});

test('a category the record does not mention takes the site default', () => {
  // Ads was never put to this visitor, and its default is off.
  assert.deepEqual(parseConsent(JSON.stringify({ v: 2, grants: { analytics: 'granted' }, ts: 1 })), {
    v: 2,
    grants: { analytics: 'granted', ads: 'denied' },
    ts: 1,
  });
  // Analytics was never put to this visitor either, and its default is on.
  assert.deepEqual(parseConsent(JSON.stringify({ v: 2, grants: { ads: 'granted' }, ts: 1 })), {
    v: 2,
    grants: { analytics: 'granted', ads: 'granted' },
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
  // when it was written, so it takes the default, which is off.
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

test('a record from an older policy version is honoured, not re-prompted', () => {
  // There is nothing to prompt with any more; what the visitor decided stands.
  assert.deepEqual(resolveConsent(parseConsent(legacy('denied')), false), {
    effects: { analytics: 'deny', ads: 'deny' },
  });
  assert.deepEqual(resolveConsent(record(uniformGrants('granted'), POLICY_VERSION - 1), false), {
    effects: { analytics: 'grant', ads: 'grant' },
  });
});

test('a privacy signal always declines every category', () => {
  // Wins even over a stored grant of both categories, and over the default.
  const denied = { effects: { analytics: 'deny', ads: 'deny' } };
  assert.deepEqual(resolveConsent(record(uniformGrants('granted')), true), denied);
  assert.deepEqual(resolveConsent(null, true), denied);
  assert.deepEqual(resolveConsent(parseConsent(legacy('granted')), true), denied);
});

test('a stored record applies each category silently and independently', () => {
  assert.deepEqual(resolveConsent(record({ analytics: 'granted', ads: 'denied' }), false), {
    effects: { analytics: 'grant', ads: 'deny' },
  });
  assert.deepEqual(resolveConsent(record({ analytics: 'denied', ads: 'granted' }), false), {
    effects: { analytics: 'deny', ads: 'grant' },
  });
  assert.deepEqual(resolveConsent(record(uniformGrants('granted')), false), {
    effects: { analytics: 'grant', ads: 'grant' },
  });
  assert.deepEqual(resolveConsent(record(uniformGrants('denied')), false), {
    effects: { analytics: 'deny', ads: 'deny' },
  });
});

test('no stored record applies the site default: analytics on, ads off, nothing pending', () => {
  assert.deepEqual(resolveConsent(null, false), {
    effects: { analytics: 'grant', ads: 'deny' },
  });
});

test('every category the site declares is resolved, none left undefined', () => {
  // Guards the next category added to CONSENT_CATEGORIES: a resolution missing an
  // effect reads as `undefined` at the call site, which is neither grant nor deny.
  const { effects } = resolveConsent(null, false);
  assert.deepEqual(Object.keys(effects).sort(), [...CONSENT_CATEGORIES].sort());
  assert.deepEqual(Object.keys(uniformGrants('denied')).sort(), [...CONSENT_CATEGORIES].sort());
  assert.deepEqual(Object.keys(DEFAULT_GRANTS).sort(), [...CONSENT_CATEGORIES].sort());
});
