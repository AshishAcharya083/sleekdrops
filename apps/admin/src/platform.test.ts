/**
 * The selected platform: which header every request carries, how a switch
 * empties what the previous platform's polls were holding, which tabs and
 * offers a platform shows, and how an event time is read and written in its
 * edition's zone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlatformSelection,
  fmtEventTime,
  isEventExpired,
  isoToZonedInput,
  offersEnabled,
  PLATFORM_HEADER,
  PLATFORM_STORAGE_KEY,
  platformHeaders,
  resolveSelection,
  siteArticleUrl,
  visibleTabs,
  zonedInputToIso,
  type KeyValueStore,
  type PlatformInfo,
} from './platform.ts';

function store(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function platform(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    id: 'sleekdrops',
    name: 'SleekDrops',
    monetisation: 'amazon',
    distribution_enabled: true,
    categories: ['Tech', 'Home'],
    post_types: ['article', 'guide'],
    editions: [{ id: 'au', name: 'Australia', time_zone: 'Australia/Sydney', locale: 'en-AU', currency: 'AUD' }],
    ...overrides,
  };
}

const peakodds = platform({
  id: 'peakodds',
  name: 'PeakOdds',
  monetisation: 'none',
  distribution_enabled: false,
  editions: [
    { id: 'au', name: 'Australia', time_zone: 'Australia/Sydney', locale: 'en-AU', currency: 'AUD' },
    { id: 'global', name: 'Global', time_zone: 'UTC', locale: 'en-GB', currency: null },
  ],
});

test('every request names the selected platform in X-Platform', () => {
  assert.equal(PLATFORM_HEADER, 'X-Platform');
  for (const [path, method] of [
    ['/api/topics', 'GET'],
    ['/api/topics/manual', 'POST'],
    ['/api/platform/profile', 'PUT'],
    ['/api/published/some-slug', 'DELETE'],
    ['/api/articles?stage=write', 'GET'],
  ]) {
    assert.deepEqual(platformHeaders(path, method, 'peakodds'), { 'X-Platform': 'peakodds' }, `${method} ${path}`);
  }
});

test('the platform list itself is fetched without one', () => {
  assert.deepEqual(platformHeaders('/api/platforms', 'GET', 'peakodds'), {});
  assert.deepEqual(platformHeaders('/api/platforms', 'get', 'peakodds'), {});
  assert.deepEqual(platformHeaders('/api/platforms?fresh=1', 'GET', 'peakodds'), {});
  // Only that one route: the profile endpoints share the prefix and are scoped.
  assert.deepEqual(platformHeaders('/api/platform/profile', 'GET', 'peakodds'), { 'X-Platform': 'peakodds' });
});

test('with nothing selected yet no header is invented', () => {
  assert.deepEqual(platformHeaders('/api/topics', 'GET', null), {});
});

test('the selection starts from what was remembered', () => {
  assert.equal(createPlatformSelection(store({ [PLATFORM_STORAGE_KEY]: 'peakodds' })).get(), 'peakodds');
  assert.equal(createPlatformSelection(store()).get(), null);
  assert.equal(createPlatformSelection(store({ [PLATFORM_STORAGE_KEY]: '' })).get(), null);
});

test('switching persists the choice and tells every cached poll to drop its data', () => {
  const storage = store({ [PLATFORM_STORAGE_KEY]: 'sleekdrops' });
  const selection = createPlatformSelection(storage);
  // Two polls holding SleekDrops data, as two mounted tabs would.
  const caches = [{ data: ['sleekdrops topic'] as string[] | null }, { data: ['sleekdrops post'] as string[] | null }];
  const seen: string[] = [];
  const unsubscribe = caches.map((cache) =>
    selection.subscribe((id) => {
      cache.data = null;
      seen.push(id);
    }),
  );

  assert.equal(selection.select('peakodds'), true);
  assert.equal(selection.get(), 'peakodds');
  assert.equal(storage.data[PLATFORM_STORAGE_KEY], 'peakodds');
  assert.deepEqual(caches.map((c) => c.data), [null, null], 'no SleekDrops data survives the switch');
  assert.deepEqual(seen, ['peakodds', 'peakodds']);

  // A poll that has unmounted is not called again.
  unsubscribe[0]();
  caches[0].data = ['peakodds topic'];
  selection.select('sleekdrops');
  assert.deepEqual(caches[0].data, ['peakodds topic']);
  assert.equal(caches[1].data, null);
});

test('re-selecting the current platform changes nothing and clears nothing', () => {
  const selection = createPlatformSelection(store({ [PLATFORM_STORAGE_KEY]: 'sleekdrops' }));
  let cleared = 0;
  selection.subscribe(() => cleared++);
  assert.equal(selection.select('sleekdrops'), false);
  assert.equal(cleared, 0);
});

test('a second browser tab switching platforms does not move this one', () => {
  const shared = store({ [PLATFORM_STORAGE_KEY]: 'sleekdrops' });
  const thisTab = createPlatformSelection(shared);
  const otherTab = createPlatformSelection(shared);
  otherTab.select('peakodds');
  assert.equal(thisTab.get(), 'sleekdrops', 'requests from this tab keep naming the platform it shows');
  assert.equal(platformHeaders('/api/topics', 'GET', thisTab.get())[PLATFORM_HEADER], 'sleekdrops');
});

test('the panel opens on the remembered platform, else the first one listed', () => {
  const listed = [platform(), peakodds];
  assert.equal(resolveSelection(listed, 'peakodds')?.id, 'peakodds');
  assert.equal(resolveSelection(listed, null)?.id, 'sleekdrops');
  assert.equal(resolveSelection(listed, 'retired')?.id, 'sleekdrops', 'a platform no longer listed is not kept');
  assert.equal(resolveSelection([peakodds, platform()], null)?.id, 'peakodds', 'no platform is hardcoded first');
  assert.equal(resolveSelection([], 'sleekdrops'), null);
});

const TABS = ['Overview', 'Topics', 'Pipeline', 'Published', 'Channels', 'Sessions', 'Settings'] as const;

test('Channels is hidden while a platform does not distribute', () => {
  assert.deepEqual(visibleTabs(TABS, platform()), [...TABS]);
  assert.deepEqual(
    visibleTabs(TABS, peakodds),
    ['Overview', 'Topics', 'Pipeline', 'Published', 'Sessions', 'Settings'],
  );
  assert.ok(visibleTabs(TABS, platform({ distribution_enabled: false })).every((t) => t !== 'Channels'));
});

test('offers are hidden for a platform with no monetisation', () => {
  assert.equal(offersEnabled(platform()), true);
  assert.equal(offersEnabled(peakodds), false);
});

test('an event-bound piece is expired from kick-off on, and only an event-bound one', () => {
  const kickOff = Date.parse('2026-10-03T09:30:00Z');
  assert.equal(isEventExpired('2026-10-03T19:30:00+10:00', kickOff - 1), false);
  assert.equal(isEventExpired('2026-10-03T19:30:00+10:00', kickOff), true);
  assert.equal(isEventExpired('2026-10-03T19:30:00+10:00', kickOff + 60_000), true);
  assert.equal(isEventExpired(null, kickOff), false);
  assert.equal(isEventExpired(undefined, kickOff), false);
  assert.equal(isEventExpired('not a date', kickOff), false);
});

test('an event time is shown in the edition zone, with the zone named', () => {
  const sydney = fmtEventTime('2026-10-03T09:30:00Z', peakodds.editions[0]);
  assert.match(sydney, /7:30/);
  assert.match(sydney, /AEST|GMT\+10/);
  const global = fmtEventTime('2026-10-03T09:30:00Z', peakodds.editions[1]);
  assert.match(global, /09:30|9:30/);
  assert.match(global, /UTC/);
  assert.equal(fmtEventTime('garbage', null), 'garbage');
});

test('a kick-off typed in the edition zone is sent as ISO 8601 with that offset', () => {
  assert.equal(zonedInputToIso('2026-10-03T19:30', 'Australia/Sydney'), '2026-10-03T19:30:00+10:00');
  // After the October daylight-saving change Sydney is +11.
  assert.equal(zonedInputToIso('2026-10-10T19:30', 'Australia/Sydney'), '2026-10-10T19:30:00+11:00');
  assert.equal(zonedInputToIso('2026-10-03T09:30', 'UTC'), '2026-10-03T09:30:00+00:00');
  assert.equal(zonedInputToIso('2026-10-03T20:00', 'America/New_York'), '2026-10-03T20:00:00-04:00');
  assert.equal(
    Date.parse(zonedInputToIso('2026-10-03T19:30', 'Australia/Sydney')!),
    Date.parse('2026-10-03T09:30:00Z'),
  );
  assert.equal(zonedInputToIso('', 'UTC'), null);
  assert.equal(zonedInputToIso('2026-10-03', 'UTC'), null);
});

test('a stored kick-off reads back into the input in the same zone', () => {
  assert.equal(isoToZonedInput('2026-10-03T09:30:00Z', 'Australia/Sydney'), '2026-10-03T19:30');
  assert.equal(isoToZonedInput('2026-10-03T19:30:00+10:00', 'UTC'), '2026-10-03T09:30');
  assert.equal(isoToZonedInput(null, 'UTC'), '');
  for (const wall of ['2026-10-03T19:30', '2026-12-31T23:59', '2027-04-05T01:15']) {
    assert.equal(isoToZonedInput(zonedInputToIso(wall, 'Australia/Sydney'), 'Australia/Sydney'), wall);
  }
});

test('a published slug links only to a site the panel knows', () => {
  assert.equal(siteArticleUrl('sleekdrops', 'best-desks'), 'https://sleekdrops.com/blog/best-desks/');
  assert.equal(siteArticleUrl('peakodds', 'afl-grand-final-preview'), null);
});
