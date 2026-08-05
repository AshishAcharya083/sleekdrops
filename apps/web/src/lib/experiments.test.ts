import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearStickyProps,
  coerceFeatureValue,
  getFeatureValue,
  isFlagHostAllowed,
  restoreStickyProps,
  stickyProps,
  subscribe,
} from './experiments.ts';

/** Minimal localStorage stand-in - the module only uses get/set/removeItem. */
function fakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    has: (k: string) => store.has(k),
  };
}

function withStorage(storage: ReturnType<typeof fakeStorage>, run: () => void): void {
  const global = globalThis as { localStorage?: unknown };
  const previous = global.localStorage;
  global.localStorage = storage;
  try {
    run();
  } finally {
    global.localStorage = previous;
  }
}

// Module state is shared across a file, so no sticky test may depend on what
// the one before it left behind.
beforeEach(() => clearStickyProps());

/* start() is never called here, which is exactly the state the site is in for a
   visitor who has not consented, has declined, sends GPC/DNT, or is offline:
   no GrowthBook instance, no payload, no exposure. */

test('every feature read returns its code-side default with no payload loaded', () => {
  assert.equal(getFeatureValue('hero_cta_copy', 'Read the latest'), 'Read the latest');
  assert.equal(getFeatureValue('drop_panel_limit', 3), 3);
  assert.equal(getFeatureValue('show_promo_strip', false), false);
});

test('a subscriber runs immediately so callers render the defaults', () => {
  let runs = 0;
  subscribe(() => {
    runs += 1;
  });
  assert.equal(runs, 1);
});

test('a subscriber that throws does not surface to the caller', () => {
  assert.doesNotThrow(() =>
    subscribe(() => {
      throw new Error('boom');
    }),
  );
});

test('coerceFeatureValue keeps a payload value of the default\'s type', () => {
  assert.equal(coerceFeatureValue('Browse the archive', 'Read the latest'), 'Browse the archive');
  assert.equal(coerceFeatureValue(7, 3), 7);
  assert.equal(coerceFeatureValue(true, false), true);
});

test('coerceFeatureValue falls back on a missing or wrong-typed payload value', () => {
  assert.equal(coerceFeatureValue(undefined, 'Read the latest'), 'Read the latest');
  assert.equal(coerceFeatureValue(null, 'Read the latest'), 'Read the latest');
  assert.equal(coerceFeatureValue(42, 'Read the latest'), 'Read the latest');
  assert.equal(coerceFeatureValue({ copy: 'nested' }, 'Read the latest'), 'Read the latest');
  assert.equal(coerceFeatureValue('3', 3), 3);
});

test('coerceFeatureValue falls back on a blank string, so a CTA is never empty', () => {
  assert.equal(coerceFeatureValue('', 'Read the latest'), 'Read the latest');
  assert.equal(coerceFeatureValue('   ', 'Read the latest'), 'Read the latest');
});

test('no sticky stamps exist for a visitor who has not been bucketed', () => {
  assert.deepEqual(stickyProps(), {});
});

test('restores the stamps written on an earlier page load', () => {
  // The site is multi-page: a visitor is bucketed on the page that reads the
  // feature and converts on a later page that never does.
  const storage = fakeStorage({
    'sd-exp': JSON.stringify({ $exp_hero_cta_copy: 'shorter-copy' }),
  });
  withStorage(storage, restoreStickyProps);
  assert.deepEqual(stickyProps(), { $exp_hero_cta_copy: 'shorter-copy' });
});

test('ignores anything in storage that is not a $exp_ string stamp', () => {
  const storage = fakeStorage({
    'sd-exp': JSON.stringify({
      $exp_kept: 'control',
      email: 'jordan@example.com',
      $exp_wrong_type: { nested: true },
      '$exp_not a key': 'control',
      $exp_over_length: 'v'.repeat(65),
    }),
  });
  withStorage(storage, restoreStickyProps);
  assert.deepEqual(stickyProps(), { $exp_kept: 'control' });
});

test('retains a bounded number of stamps, whatever the payload wrote', () => {
  // Stamp names come from the flag payload, so an unbounded store would grow
  // both localStorage and every outgoing analytics payload without limit.
  const stored: Record<string, string> = {};
  for (let i = 0; i < 100; i += 1) stored[`$exp_flag_${i}`] = 'control';
  withStorage(fakeStorage({ 'sd-exp': JSON.stringify(stored) }), restoreStickyProps);
  assert.equal(Object.keys(stickyProps()).length, 32);
});

test('survives corrupt or absent storage without throwing', () => {
  withStorage(fakeStorage({ 'sd-exp': 'not json' }), () =>
    assert.doesNotThrow(restoreStickyProps),
  );
  withStorage(fakeStorage(), () => assert.doesNotThrow(restoreStickyProps));
  assert.deepEqual(stickyProps(), {});
});

test('a https page only reads the flag payload over https', () => {
  // The payload decides what renders and how visitors are bucketed, and it is
  // neither signed nor encrypted, so a plaintext fetch is a rewrite point for
  // any network intermediary - and mixed content the browser blocks anyway.
  assert.equal(isFlagHostAllowed('https://app.internal.getdevteam.ai', 'https:'), true);
  assert.equal(isFlagHostAllowed('http://app.internal.getdevteam.ai', 'https:'), false);
});

test('a http page (local dev) may read the payload over http', () => {
  assert.equal(isFlagHostAllowed('http://localhost:6080', 'http:'), true);
  assert.equal(isFlagHostAllowed('https://app.internal.getdevteam.ai', 'http:'), true);
});

test('an unparseable host disables experiments rather than being fetched', () => {
  assert.equal(isFlagHostAllowed('app.internal.getdevteam.ai', 'https:'), false);
  assert.equal(isFlagHostAllowed('', 'http:'), false);
});

test('a decline forgets every stamp, in memory and on disk', () => {
  const storage = fakeStorage({
    'sd-exp': JSON.stringify({ $exp_hero_cta_copy: 'shorter-copy' }),
  });
  withStorage(storage, restoreStickyProps);
  assert.notDeepEqual(stickyProps(), {});
  withStorage(storage, clearStickyProps);
  assert.deepEqual(stickyProps(), {});
  assert.equal(storage.has('sd-exp'), false);
});
