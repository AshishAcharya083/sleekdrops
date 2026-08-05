import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearStickyProps,
  coerceFeatureValue,
  getFeatureValue,
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
    }),
  });
  withStorage(storage, restoreStickyProps);
  assert.deepEqual(stickyProps(), { $exp_kept: 'control' });
});

test('survives corrupt or absent storage without throwing', () => {
  withStorage(fakeStorage({ 'sd-exp': 'not json' }), () =>
    assert.doesNotThrow(restoreStickyProps),
  );
  withStorage(fakeStorage(), () => assert.doesNotThrow(restoreStickyProps));
  assert.deepEqual(stickyProps(), {});
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
