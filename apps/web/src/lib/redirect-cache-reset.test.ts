/**
 * The reset has to fire exactly once per browser: never firing leaves a trapped
 * visitor trapped, and firing repeatedly would clear the HTTP cache on every
 * page load. Storage that throws is the third case - a browser with storage
 * disabled cannot track a one-shot, so it must do nothing rather than loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESET_FLAG,
  RESET_GENERATION,
  RESET_URL,
  resetRedirectCache,
} from './redirect-cache-reset.ts';

/** Local storage that works, seeded with whatever a previous visit left. */
const storage = (seed: Record<string, string> = {}) => {
  const store = { ...seed };
  return {
    store,
    read: (key: string) => store[key] ?? null,
    write: (key: string, value: string) => {
      store[key] = value;
    },
  };
};

const recorder = () => {
  const urls: string[] = [];
  return { urls, request: async (url: string) => void urls.push(url) };
};

test('a browser that has never been reset requests the cache-clearing asset', async () => {
  const s = storage();
  const r = recorder();
  assert.equal(await resetRedirectCache({ ...s, request: r.request }), true);
  assert.deepEqual(r.urls, [RESET_URL]);
  assert.equal(s.store[RESET_FLAG], RESET_GENERATION);
});

test('a browser already reset for this generation makes no request', async () => {
  const r = recorder();
  const s = storage({ [RESET_FLAG]: RESET_GENERATION });
  assert.equal(await resetRedirectCache({ ...s, request: r.request }), false);
  assert.deepEqual(r.urls, []);
});

test('a flag from an older generation resets again', async () => {
  const r = recorder();
  const s = storage({ [RESET_FLAG]: '2025-01-something-else' });
  assert.equal(await resetRedirectCache({ ...s, request: r.request }), true);
  assert.deepEqual(r.urls, [RESET_URL]);
});

test('the flag is written before the request, so a failure cannot retry forever', async () => {
  const s = storage();
  const failing = { ...s, request: async () => { throw new Error('offline'); } };
  assert.equal(await resetRedirectCache(failing), false);
  assert.equal(s.store[RESET_FLAG], RESET_GENERATION);

  const r = recorder();
  assert.equal(await resetRedirectCache({ ...s, request: r.request }), false);
  assert.deepEqual(r.urls, []);
});

test('storage that throws on read does nothing rather than clear every load', async () => {
  const r = recorder();
  const result = await resetRedirectCache({
    read: () => { throw new Error('storage disabled'); },
    write: () => {},
    request: r.request,
  });
  assert.equal(result, false);
  assert.deepEqual(r.urls, []);
});

test('storage that throws on write does not request either', async () => {
  const r = recorder();
  const result = await resetRedirectCache({
    read: () => null,
    write: () => { throw new Error('quota exceeded'); },
    request: r.request,
  });
  assert.equal(result, false);
  assert.deepEqual(r.urls, []);
});
