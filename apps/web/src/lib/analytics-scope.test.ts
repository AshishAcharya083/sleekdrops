/**
 * The regression suite for the duplicate top-of-funnel events reported on
 * 2026-08-08 (signature 1707c53280a2635389cbc470003e7016): four events in a
 * zero-second span, `$session_start` -> `Page Viewed` -> `$session_start` ->
 * `Page Viewed`.
 *
 * Everything here runs against the **real** DevTeam SDK wired to in-test storage
 * and transport (the `distinct-id.test.ts` pattern), because the behaviour that
 * produced the duplicate is the SDK's own: it opens a session per client, and it
 * persists its unflushed queue to localStorage and restores it into the next
 * client. `reproducesTheReportedDuplicate` below is that reproduction, and the
 * tests after it are the guards that make each half of it impossible.
 *
 * `./analytics.ts` itself cannot be imported here - it reads Vite's
 * `import.meta.env`, which does not exist under the bare `node --test` runner
 * (same constraint taxonomy.test.ts documents). So `analyticsModule()` composes
 * the exact exports analytics.ts composes, in the same order, and the
 * source-parity assertions at the end of this file fail if analytics.ts or
 * chrome.ts stops wiring them that way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createAnalytics,
  type AnalyticsClient,
  type StorageAdapter,
  type WebAnalyticsConfig,
} from '@getdevteam/analytics-web';

import {
  analyticsScope,
  bufferEvent,
  claimOnce,
  drainBuffer,
  dropBuffer,
  ensureClient,
  type ScopeHost,
} from './analytics-scope.ts';
import { scrub, type EventProps } from './pii.ts';
import { VISIT_IDLE_MS, newEventId, normalizePath, touchVisit, type VisitStorage } from './visit.ts';

const PAGE_VIEW = 'Page Viewed';
const SESSION_START = '$session_start';

interface WireEvent {
  event_id: string;
  name: string;
  session_id: string;
  properties?: Record<string, unknown>;
}

/**
 * One browser tab: a localStorage that survives every page load in it (where the
 * SDK keeps its device id and its unflushed queue), a sessionStorage that lives
 * as long as the tab (where the visit id lives), a controllable clock, and every
 * event the ingest host actually received.
 */
function browserTab() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const received: WireEvent[] = [];
  return { local, session, received, clock: 1_700_000_000_000 };
}

type BrowserTab = ReturnType<typeof browserTab>;

const asStorage = (map: Map<string, string>): StorageAdapter & VisitStorage => ({
  getItem: (key) => map.get(key) ?? null,
  setItem: (key, value) => void map.set(key, value),
  removeItem: (key) => void map.delete(key),
});

/**
 * One instance of the analytics module, resolving its state from `host` - the
 * document-scoped global. Pass the same host twice to model two copies of the
 * module in ONE document; pass a fresh host to model the next page load.
 */
function analyticsModule(tab: BrowserTab, host: ScopeHost, url: string) {
  const scope = analyticsScope<AnalyticsClient>(host);
  let clientsCreated = 0;

  const createClient = (): AnalyticsClient => {
    clientsCreated++;
    const fetchImpl: WebAnalyticsConfig['fetch'] = (_url, init) => {
      const payload = JSON.parse(init.body) as { events?: WireEvent[] };
      tab.received.push(...(payload.events ?? []));
      return Promise.resolve({ ok: true, status: 200 });
    };
    return createAnalytics({
      key: 'dtp_test',
      host: 'http://analytics.test',
      storage: asStorage(tab.local),
      fetch: fetchImpl,
      now: () => tab.clock,
      trackPageviews: false,
      autoCaptureErrors: false,
    });
  };

  // Mirrors analytics.ts visitStamp(): nothing is read or written before consent.
  const visitStamp = (): EventProps =>
    scope.decision === 'granted' ? { visit_id: touchVisit(asStorage(tab.session), tab.clock) } : {};

  const send = (item: { event: string; props?: EventProps }): void => {
    scope.client?.track(item.event, scrub({ ...item.props, ...visitStamp() }, item.event));
  };

  const track = (event: string, props?: EventProps): void => {
    if (scope.decision === 'denied') return;
    const item = { event, props: { ...props, event_id: newEventId() } };
    if (scope.decision === 'granted') {
      send(item);
      return;
    }
    bufferEvent(scope, item);
  };

  return {
    scope,
    clientsCreated: () => clientsCreated,
    grant: (): void => {
      if (scope.decision === 'granted') return;
      scope.decision = 'granted';
      ensureClient(scope, createClient);
      drainBuffer(scope).forEach(send);
    },
    deny: (): void => {
      if (scope.decision === 'denied') return;
      scope.decision = 'denied';
      dropBuffer(scope);
    },
    track,
    /** What chrome.ts calls: the guarded, path-normalizing page-view dispatch. */
    trackPageView: (props?: EventProps): void => {
      const path = normalizePath(url);
      if (!claimOnce(scope, `${PAGE_VIEW}|${path}`)) return;
      track(PAGE_VIEW, { ...props, path });
    },
    flush: (): Promise<void> => scope.client?.flush() ?? Promise.resolve(),
  };
}

const names = (tab: BrowserTab): string[] => tab.received.map((event) => event.name);
const distinct = (values: unknown[]): unknown[] => [...new Set(values)];
const countOf = (tab: BrowserTab, name: string): number =>
  names(tab).filter((value) => value === name).length;

/**
 * The events this site emits. `$session_start` is minted inside the SDK and
 * carries no properties at all, so it has neither of the ids this site stamps -
 * it joins to a visit through the `session_id` it shares with the events that do
 * (asserted below).
 */
const ownEvents = (tab: BrowserTab): WireEvent[] =>
  tab.received.filter((event) => event.name !== SESSION_START);
const propOf = (tab: BrowserTab, key: string): unknown[] =>
  ownEvents(tab).map((event) => event.properties?.[key]);

/** Every `$session_start` resolves to a visit through its session id. */
function assertSessionStartsJoinToAVisit(tab: BrowserTab): void {
  const visitOfSession = new Map(
    ownEvents(tab).map((event) => [event.session_id, event.properties?.visit_id]),
  );
  tab.received
    .filter((event) => event.name === SESSION_START)
    .forEach((event) => {
      assert.ok(
        visitOfSession.get(event.session_id),
        `${SESSION_START} must be joinable to a visit through its session_id`,
      );
    });
}

test('REPRODUCTION: two loads in one visit are what produced the reported four events', async () => {
  // No guards, no visit id: the shape the platform recorded, from the SDK alone.
  const tab = browserTab();
  const local = asStorage(tab.local);
  const rawClient = (): AnalyticsClient =>
    createAnalytics({
      key: 'dtp_test',
      host: 'http://analytics.test',
      storage: local,
      fetch: (_url, init) => {
        const payload = JSON.parse(init.body) as { events?: WireEvent[] };
        tab.received.push(...(payload.events ?? []));
        return Promise.resolve({ ok: true, status: 200 });
      },
      now: () => tab.clock,
      trackPageviews: false,
      autoCaptureErrors: false,
    });

  const first = rawClient();
  first.track(PAGE_VIEW, { path: '/' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Nothing has been delivered yet: the SDK flushes at 20 events or every 5s, so
  // the first load's events are sitting in localStorage when the second starts.
  assert.deepEqual(tab.received, []);

  tab.clock += 300;
  const second = rawClient();
  second.track(PAGE_VIEW, { path: '/' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await second.flush();

  // The reported signature, exactly - including the interleaved order, which is
  // the restored queue landing in front of the new load's own events.
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW, SESSION_START, PAGE_VIEW]);
  assert.equal(distinct(tab.received.map((event) => event.session_id)).length, 2);
  await first.shutdown();
  await second.shutdown();
});

test('two module copies in one document share one client, and so open one session', async () => {
  const tab = browserTab();
  const document: ScopeHost = {};
  // Two distinct module instances - what a build that inlines the module per
  // script entry point produces - resolving state from the same document.
  const chrome = analyticsModule(tab, document, '/');
  const banner = analyticsModule(tab, document, '/');

  assert.equal(chrome.scope, banner.scope, 'both copies must see one state object');

  banner.grant();
  chrome.grant();
  chrome.trackPageView({ referrer: '' });
  banner.track('Hero CTA Clicked', { cta: 'Read the latest' });
  await chrome.flush();

  assert.equal(chrome.clientsCreated() + banner.clientsCreated(), 1);
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW, 'Hero CTA Clicked']);
  assert.equal(distinct(tab.received.map((event) => event.session_id)).length, 1);
});

test('a second entry point asking for a client is handed the first one', () => {
  const tab = browserTab();
  const document: ScopeHost = {};
  const scope = analyticsScope<AnalyticsClient>(document);
  let created = 0;
  const create = (): AnalyticsClient => {
    created++;
    return createAnalytics({
      key: 'dtp_test',
      host: 'http://analytics.test',
      storage: asStorage(tab.local),
      fetch: () => Promise.resolve({ ok: true, status: 200 }),
      trackPageviews: false,
      autoCaptureErrors: false,
    });
  };

  assert.equal(ensureClient(scope, create), ensureClient(scope, create));
  assert.equal(created, 1);
});

test('a page view buffered by one module copy is flushed by the other, once', async () => {
  const tab = browserTab();
  const document: ScopeHost = {};
  const chrome = analyticsModule(tab, document, '/');
  const banner = analyticsModule(tab, document, '/');

  // chrome.ts dispatches before the visitor has chosen; the banner grants after.
  chrome.trackPageView({ referrer: '' });
  const bufferedId = chrome.scope.buffer[0]?.props?.event_id;
  banner.grant();
  // A second grant (the visitor re-saving preferences) must not re-flush it.
  banner.grant();
  chrome.grant();
  await banner.flush();

  assert.equal(countOf(tab, PAGE_VIEW), 1);
  assert.equal(countOf(tab, SESSION_START), 1);
  // The id the event was created with is the id that reached the platform, so a
  // buffered event that is re-sent still collapses.
  assert.match(String(bufferedId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(propOf(tab, 'event_id'), [bufferedId]);
});

test('draining the buffer empties it, so no flush can send the same event twice', () => {
  const scope = analyticsScope<AnalyticsClient>({});
  const first = { event: PAGE_VIEW, props: { event_id: newEventId() } };
  bufferEvent(scope, first);
  bufferEvent(scope, { event: 'Hero CTA Clicked', props: { event_id: newEventId() } });

  const drained = drainBuffer(scope);
  assert.equal(drained.length, 2);
  assert.equal(drained[0], first, 'an event must come back exactly as it went in');
  assert.deepEqual(drainBuffer(scope), []);

  bufferEvent(scope, first);
  dropBuffer(scope);
  assert.deepEqual(drainBuffer(scope), []);
});

test('dispatching the page view twice in one document emits one event', async () => {
  const tab = browserTab();
  const load = analyticsModule(tab, {}, '/deals/foo');
  load.grant();

  load.trackPageView({ referrer: '' });
  load.trackPageView({ referrer: '' });
  load.trackPageView({ referrer: '' });
  await load.flush();

  assert.equal(countOf(tab, PAGE_VIEW), 1);
  assert.equal(countOf(tab, SESSION_START), 1);
});

test('the guard is per path, so a same-document navigation is still counted', async () => {
  const tab = browserTab();
  const document: ScopeHost = {};
  const home = analyticsModule(tab, document, '/');
  const deal = analyticsModule(tab, document, '/deals/foo');
  home.grant();

  home.trackPageView({ referrer: '' });
  deal.trackPageView({ referrer: '' });
  await home.flush();

  assert.equal(countOf(tab, PAGE_VIEW), 2);
  assert.deepEqual(propOf(tab, 'path'), ['/', '/deals/foo']);
});

test('a slash-suffixed entry URL is one page and one visit across the redirect', async () => {
  const tab = browserTab();

  // Load 1: the visitor arrives on the slash-suffixed URL.
  const entry = analyticsModule(tab, {}, '/deals/foo/');
  entry.grant();
  entry.trackPageView({ referrer: '' });
  await entry.flush();

  // Load 2: the redirect's destination, a fresh document 300ms later.
  tab.clock += 300;
  const destination = analyticsModule(tab, {}, '/deals/foo');
  destination.grant();
  destination.trackPageView({ referrer: '' });
  await destination.flush();

  // One page view per load and no more, both under one spelling of the path: the
  // redirect cannot split the count across `/deals/foo/` and `/deals/foo`.
  assert.equal(countOf(tab, PAGE_VIEW), 2);
  assert.deepEqual(distinct(propOf(tab, 'path')), ['/deals/foo']);
  // One visit: the identity that groups the two loads is continuous, even though
  // the SDK opened a session per document (0.2.0 keeps its session id in memory
  // and exposes no way to restore it - see ./visit), and every `$session_start`
  // it emitted resolves to that one visit.
  assert.equal(distinct(propOf(tab, 'visit_id')).length, 1);
  assert.ok(distinct(propOf(tab, 'visit_id'))[0], 'every event must carry a visit id');
  assertSessionStartsJoinToAVisit(tab);
  // Every event still carries its own idempotency key.
  const ids = propOf(tab, 'event_id');
  assert.equal(ids.length, ownEvents(tab).length);
  assert.equal(distinct(ids).length, ids.length);
});

test('a visit that goes quiet for the idle window is counted as a new visit', async () => {
  const tab = browserTab();
  const first = analyticsModule(tab, {}, '/');
  first.grant();
  first.trackPageView({ referrer: '' });
  await first.flush();

  tab.clock += VISIT_IDLE_MS + 1;
  const later = analyticsModule(tab, {}, '/');
  later.grant();
  later.trackPageView({ referrer: '' });
  await later.flush();

  assert.equal(distinct(propOf(tab, 'visit_id')).length, 2);
});

test('nothing is stored, and no visit opened, before the visitor consents', async () => {
  const tab = browserTab();
  const load = analyticsModule(tab, {}, '/');

  load.trackPageView({ referrer: '' });
  load.deny();
  load.track('Hero CTA Clicked', { cta: 'Read the latest' });
  await load.flush();

  assert.deepEqual(tab.received, []);
  assert.equal(tab.session.size, 0, 'sd_sid must not exist for a visitor who declined');
  assert.equal(tab.local.size, 0, 'the SDK must never have been created');
});

/* ---- Source parity ----------------------------------------------------------
 * analytics.ts cannot be imported under the bare node runner (see the header), so
 * these read it as text - the same approach, and for the same reason, as
 * taxonomy.test.ts. They are what stops the module drifting away from the
 * composition the tests above exercise. */

const libDir = fileURLToPath(new URL('.', import.meta.url));
const read = (path: string): string => readFileSync(libDir + path, 'utf8');
const analyticsSource = read('analytics.ts');
const chromeSource = read('../scripts/chrome.ts');

test('chrome.ts dispatches the page view only through the guarded entry point', () => {
  assert.match(chromeSource, /\btrackPageView\(/);
  assert.doesNotMatch(
    chromeSource,
    /\btrack\(\s*EVENTS\.pageView/,
    'the page view must go through trackPageView, which holds the one-per-document guard',
  );
});

test('analytics.ts mints the event id at the call site, before the consent buffer', () => {
  const trackBody = /export function track\([\s\S]*?\n}/.exec(analyticsSource)?.[0] ?? '';
  const mintIndex = trackBody.indexOf('newEventId()');
  const bufferIndex = trackBody.indexOf('bufferEvent(');
  assert.ok(mintIndex > 0, 'track() must mint an event_id');
  assert.ok(bufferIndex > 0, 'track() must buffer through bufferEvent()');
  assert.ok(mintIndex < bufferIndex, 'the id must be minted before the event is buffered');
});

test('withdrawal clears every storage key the SDK actually writes', async () => {
  // What analytics.ts promises to remove on a decline or withdrawal...
  const listed = /const SDK_STORAGE_KEYS = \[([^\]]*)\]/.exec(analyticsSource)?.[1];
  assert.ok(listed, 'no SDK_STORAGE_KEYS list in analytics.ts');
  const cleared = new Set([...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]));

  // ...against what a real client actually writes, so a rename or an addition
  // upstream fails here instead of silently leaving a withdrawn visitor's id behind.
  const tab = browserTab();
  const load = analyticsModule(tab, {}, '/');
  load.grant();
  load.trackPageView({ referrer: '' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const written = [...tab.local.keys()];
  assert.ok(written.length > 0, 'expected the SDK to have written to localStorage');
  written.forEach((key) => {
    assert.ok(cleared.has(key), `withdrawal does not clear the SDK key "${key}"`);
  });
});

test('analytics.ts routes client creation, the page view and withdrawal through the guards', () => {
  const between = (start: RegExp): string => {
    const body = new RegExp(start.source + '[\\s\\S]*?\\n}').exec(analyticsSource)?.[0];
    assert.ok(body, `no function body matched ${start.source}`);
    return body;
  };
  assert.match(between(/function ensureDevteam\(\): void \{/), /ensureClient\(/);
  assert.match(between(/export function trackPageView\(/), /claimOnce\(/);
  assert.match(between(/export function trackPageView\(/), /normalizePath\(/);
  assert.match(between(/function applyDeny\(\): void \{/), /forgetAnalyticsStorage\(\)/);
  assert.match(between(/function forgetAnalyticsStorage\(\): void \{/), /clearVisit\(/);
  // Every outgoing event and log carries the visit id.
  assert.match(between(/function send\(/), /visitStamp\(\)/);
  assert.match(between(/export function serverLog\(/), /visitStamp\(\)/);
});
