import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnalytics,
  type AnalyticsClient,
  type StorageAdapter,
  type WebAnalyticsConfig,
} from '@getdevteam/analytics-web';

import { whenDistinctIdRestored } from './distinct-id.ts';

/**
 * The key the SDK persists a visitor's distinct id under - its exported
 * `DISTINCT_ID_STORAGE_KEY`, restated because analytics-core is a transitive
 * dependency here. A change to it fails the returning-visitor test below rather
 * than passing silently.
 */
const SDK_DISTINCT_ID_KEY = 'devteam_analytics.distinct_id';

interface WireEventLike {
  name: string;
  distinct_id: string;
}

/**
 * A real DevTeam client wired to in-test storage and transport, so these assert
 * the SDK's actual restore behaviour rather than a stand-in's.
 */
function realClient(store: Map<string, string> = new Map()): {
  client: AnalyticsClient;
  storage: Map<string, string>;
  sentEvents: WireEventLike[];
} {
  const storage: StorageAdapter = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
  const sentEvents: WireEventLike[] = [];
  const fetchImpl: WebAnalyticsConfig['fetch'] = (_url, init) => {
    const payload = JSON.parse(init.body) as { events?: WireEventLike[] };
    sentEvents.push(...(payload.events ?? []));
    return Promise.resolve({ ok: true, status: 200 });
  };
  const client = createAnalytics({
    key: 'dtp_test',
    host: 'http://analytics.test',
    storage,
    fetch: fetchImpl,
    trackPageviews: false,
    autoCaptureErrors: false,
  });
  return { client, storage: store, sentEvents };
}

function restoredDistinctId(client: AnalyticsClient): Promise<string> {
  return new Promise((resolve) => whenDistinctIdRestored(client, resolve));
}

/** The distinct id the SDK stamped on the events it actually delivered. */
function idsOnDeliveredEvents(sentEvents: WireEventLike[]): string[] {
  assert.ok(sentEvents.length > 0, 'expected the SDK to have delivered at least one event');
  return [...new Set(sentEvents.map((event) => event.distinct_id))];
}

test('a returning visitor buckets on the id the SDK reports, not the throwaway one', async () => {
  const store = new Map([[SDK_DISTINCT_ID_KEY, 'anon_STORED_ID']]);
  const { client, sentEvents } = realClient(store);
  const sameTickId = client.getDistinctId();

  const bucketingId = await restoredDistinctId(client);

  client.track('Hero CTA Clicked', { cta: 'Read the latest' });
  await client.flush();
  await client.shutdown();

  assert.equal(bucketingId, 'anon_STORED_ID');
  // The id an unbucketed read would have used is regenerated on every page load,
  // which is what made a returning visitor flip variants and read 0%.
  assert.notEqual(sameTickId, bucketingId);
  // The contract that matters: exposure and conversion join on one key.
  assert.deepEqual(idsOnDeliveredEvents(sentEvents), [bucketingId]);
});

test('a first-time visitor buckets on the id the SDK goes on to persist', async () => {
  const { client, storage, sentEvents } = realClient();

  const bucketingId = await restoredDistinctId(client);

  client.track('Hero CTA Clicked', { cta: 'Read the latest' });
  await client.flush();
  await client.shutdown();

  assert.match(bucketingId, /^anon_/);
  assert.equal(storage.get(SDK_DISTINCT_ID_KEY), bucketingId);
  assert.deepEqual(idsOnDeliveredEvents(sentEvents), [bucketingId]);
});

test('the same visitor keeps one bucketing id across page loads', async () => {
  // One storage, two clients: the second page load reads back what the first persisted.
  const store = new Map<string, string>();
  const first = realClient(store);
  const firstLoadId = await restoredDistinctId(first.client);
  first.client.track('Page Viewed');
  await first.client.flush();
  await first.client.shutdown();

  const second = realClient(store);
  const secondLoadId = await restoredDistinctId(second.client);
  second.client.track('Page Viewed');
  await second.client.flush();
  await second.client.shutdown();

  assert.equal(secondLoadId, firstLoadId);
  assert.deepEqual(idsOnDeliveredEvents(second.sentEvents), [firstLoadId]);
});
