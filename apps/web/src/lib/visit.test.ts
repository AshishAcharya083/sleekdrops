import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scrub } from './pii.ts';
import {
  VISIT_IDLE_MS,
  VISIT_KEY,
  clearVisit,
  newEventId,
  normalizePath,
  touchVisit,
  type RandomSource,
  type VisitStorage,
} from './visit.ts';

function storage(initial: Iterable<[string, string]> = []): VisitStorage & { map: Map<string, string> } {
  const map = new Map(initial);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('an event id is a v4 UUID and a new one every call', () => {
  const ids = Array.from({ length: 500 }, () => newEventId());
  ids.forEach((id) => assert.match(id, UUID_V4_RE));
  assert.equal(new Set(ids).size, ids.length);
});

test('an event id falls back when crypto.randomUUID is unavailable', () => {
  // What a browser on a plain-http page actually exposes: getRandomValues, no
  // randomUUID.
  const noRandomUuid: RandomSource = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  const noCryptoAtAll: RandomSource = {};
  for (const source of [noRandomUuid, noCryptoAtAll, undefined]) {
    const ids = Array.from({ length: 200 }, () => newEventId(source));
    ids.forEach((id) => assert.match(id, UUID_V4_RE));
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('an event id survives the PII scrub', () => {
  const eventId = newEventId();
  assert.equal(scrub({ event_id: eventId }, 'Page Viewed').event_id, eventId);
  assert.equal(scrub({ visit_id: eventId }, 'Page Viewed').visit_id, eventId);
});

test('an event id is short enough for every platform that dedupes on one', () => {
  // Mixpanel is the strictest: $insert_id is at most 36 bytes, alphanumeric or '-'.
  const id = newEventId();
  assert.ok(id.length <= 36, id);
  assert.match(id, /^[A-Za-z0-9-]+$/);
});

test('a trailing slash is not a second page', () => {
  // trailingSlash: 'never' in astro.config.mjs - a slash-suffixed URL redirects,
  // so both spellings have to count as one path or the redirect splits the funnel.
  assert.equal(normalizePath('/deals/foo/'), '/deals/foo');
  assert.equal(normalizePath('/deals/foo'), '/deals/foo');
  assert.equal(normalizePath('/deals/foo///'), '/deals/foo');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('///'), '/');
  // An absent value stays absent - the root is `/`, and nothing is not the root.
  assert.equal(normalizePath(''), '');
  // Query strings and fragments are dropped by urlToPath, as everywhere else.
  assert.equal(normalizePath('/deals/foo/?utm_source=x#top'), '/deals/foo');
  assert.equal(normalizePath('https://sleekdrops.com/deals/foo/'), '/deals/foo');
  // A protocol-relative value cannot smuggle another host into the path.
  assert.equal(normalizePath('//evil.example/x/'), '/x');
});

test('a visit id is minted once and reused for the rest of the visit', () => {
  const store = storage();
  const first = touchVisit(store, 1_000);
  const second = touchVisit(store, 1_000 + VISIT_IDLE_MS);
  const third = touchVisit(store, 1_000 + VISIT_IDLE_MS * 2);

  assert.match(first, UUID_V4_RE);
  // The window is rolling, so continuous reading never ends the visit.
  assert.equal(second, first);
  assert.equal(third, first);
  assert.deepEqual(JSON.parse(store.map.get(VISIT_KEY)!), {
    id: first,
    ts: 1_000 + VISIT_IDLE_MS * 2,
  });
});

test('a visit ends after the inactivity window and a new one starts', () => {
  const store = storage();
  const first = touchVisit(store, 1_000);
  const later = touchVisit(store, 1_000 + VISIT_IDLE_MS + 1);

  assert.match(later, UUID_V4_RE);
  assert.notEqual(later, first);
});

test('a visit id survives a page load, which is what keeps a redirect to one session', () => {
  // One sessionStorage, two loads: the second reads back what the first wrote.
  const store = storage();
  const firstLoad = touchVisit(store, 1_000);
  const secondLoad = touchVisit(store, 1_300);
  assert.equal(secondLoad, firstLoad);
});

test('a clock correction between loads continues the visit rather than splitting it', () => {
  const store = storage();
  const first = touchVisit(store, 10_000);
  assert.equal(touchVisit(store, 9_000), first);
});

test('a corrupt or hostile stored visit id is replaced, never stamped on an event', () => {
  const hostile = [
    'not json',
    JSON.stringify({ id: '<script>alert(1)</script>', ts: 1_000 }),
    JSON.stringify({ id: 'a'.repeat(37), ts: 1_000 }),
    JSON.stringify({ id: 'has spaces', ts: 1_000 }),
    JSON.stringify({ id: '', ts: 1_000 }),
    JSON.stringify({ id: 42, ts: 1_000 }),
    JSON.stringify(['id']),
  ];
  for (const raw of hostile) {
    const store = storage([[VISIT_KEY, raw]]);
    const id = touchVisit(store, 1_000);
    assert.match(id, UUID_V4_RE);
  }
});

test('a stored record with no timestamp is treated as an expired visit', () => {
  const store = storage([[VISIT_KEY, JSON.stringify({ id: 'kept-id' })]]);
  assert.notEqual(touchVisit(store, VISIT_IDLE_MS + 1), 'kept-id');
});

test('a visit id is minted with the injected source, never derived from the visitor', () => {
  const store = storage();
  let minted = 0;
  const id = touchVisit(store, 1_000, () => `minted-${++minted}`);
  assert.equal(id, 'minted-1');
  assert.equal(minted, 1);
});

test('withdrawal deletes the visit id, and does so safely when storage is gone', () => {
  const store = storage();
  touchVisit(store, 1_000);
  assert.ok(store.map.has(VISIT_KEY));
  clearVisit(store);
  assert.equal(store.map.has(VISIT_KEY), false);
  assert.doesNotThrow(() => clearVisit(null));
  assert.doesNotThrow(() =>
    clearVisit({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('storage blocked');
      },
    }),
  );
});

test('unavailable storage still yields a usable id for this page load', () => {
  const blocked: VisitStorage = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
    },
    removeItem: () => {},
  };
  assert.match(touchVisit(blocked, 1_000), UUID_V4_RE);
});
