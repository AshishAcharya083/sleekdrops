/**
 * The regression suite for the duplicate top-of-funnel events reported on
 * 2026-08-08 (signature 1707c53280a2635389cbc470003e7016): four events in a
 * zero-second span, `$session_start` -> `Page Viewed` -> `$session_start` ->
 * `Page Viewed`.
 *
 * Everything here drives the **shipped** `./analytics` module - imported twice,
 * as two distinct module instances, exactly as a build that inlines it into each
 * of the two client script entry points would - against the **real** DevTeam SDK
 * wired to in-test storage and transport (the `distinct-id.test.ts` pattern).
 * Both halves matter: the behaviour that produced the duplicate is the SDK's own
 * (it opens a session per client, and it persists its unflushed queue to
 * localStorage and restores it into the next client), and the guards that make it
 * impossible are the shipped module's, so a guard removed from analytics.ts has
 * to fail a test here rather than pass a test against a stand-in.
 * `REPRODUCTION` below is the reproduction; every test after it is a guard.
 *
 * The module needs two things the bare `node --test` runner cannot give it: its
 * build-time ingest key, which Vite inlines from `import.meta.env` (substituted
 * through the `./analytics-env` seam below), and a browser (a minimal `window` /
 * `document` / storage / `location` / `fetch`, installed per page load by
 * `loadPage`). Nothing else about the module is stubbed.
 *
 * Run it with `pnpm --filter @sleekdrops/web test`: substituting the env seam
 * needs node's `--experimental-test-module-mocks`, which that script passes.
 */

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAnalytics, type AnalyticsClient } from '@getdevteam/analytics-web';

import type { AnalyticsScope } from './analytics-scope.ts';
import { CONSENT_KEY, POLICY_VERSION, parseConsent } from './consent.ts';

/**
 * The one thing the real module cannot resolve outside a Vite build: the ingest
 * key and host it creates its client with. An empty key disables the sink, so
 * without this the module under test would have no client at all.
 */
let devteamKey = 'dtp_test';

mock.module(new URL('./analytics-env.ts', import.meta.url).href, {
  namedExports: {
    analyticsEnv: () => ({ key: devteamKey, host: 'http://analytics.test' }),
  },
});

/** Run `body` against a build that was given no DevTeam ingest key. */
async function noDevteamKey(body: () => Promise<void> | void): Promise<void> {
  devteamKey = '';
  try {
    await body();
  } finally {
    devteamKey = 'dtp_test';
  }
}

/**
 * The same for `./ads`, which is imported here for one thing only: the ad gate
 * reads the record this module writes, so what the consent dialog saves and what
 * the ad partner is loaded on are asserted end to end below rather than each
 * against its own idea of the record.
 */
mock.module(new URL('./ads-env.ts', import.meta.url).href, {
  namedExports: {
    adsEnv: () => ({
      client: 'ca-pub-1234567890123456',
      slots: { articleMid: '1', articleEnd: '2', sidebar: '3', feed: '4' },
    }),
  },
});

/**
 * The GA4 property this build reports into. Substituted for the same reason the
 * two above are - `import.meta.env` does not exist under the bare runner - and
 * held in a mutable binding because "no measurement id" is a supported build
 * state with its own behaviour, which `noGa4Property` below drives.
 */
let ga4Property = 'G-TEST123456';

mock.module(new URL('./ga-env.ts', import.meta.url).href, {
  namedExports: { gaEnv: () => ({ id: ga4Property }) },
});

/** Run `body` against a build that was given no GA4 measurement id. */
async function noGa4Property(body: () => Promise<void> | void): Promise<void> {
  ga4Property = '';
  try {
    await body();
  } finally {
    ga4Property = 'G-TEST123456';
  }
}

const ads = await import('./ads.ts');

type AnalyticsModule = typeof import('./analytics.ts');

/**
 * A module instance of `./analytics`. A distinct URL is a distinct instance with
 * its own module-local state, so `chrome` and `banner` below model the two client
 * script entry points resolving to two copies of the module in one document -
 * anything they share, they share because it hangs off the document.
 */
const loadModuleCopy = async (query = ''): Promise<AnalyticsModule> =>
  (await import(new URL(`./analytics.ts${query}`, import.meta.url).href)) as AnalyticsModule;

const chrome = await loadModuleCopy();
const banner = await loadModuleCopy('?copy=2');

const PAGE_VIEW = 'Page Viewed';
const SESSION_START = '$session_start';
const HERO_CTA = 'Hero CTA Clicked';
const SDK_KEY_PREFIX = 'devteam_analytics.';

interface WireEvent {
  event_id: string;
  name: string;
  session_id: string;
  properties?: Record<string, unknown>;
}

/** One log line as the platform received it; `body` is the message. */
interface WireLog {
  severity: string;
  body: string;
}

/**
 * One browser tab: a localStorage that survives every page load in it (where the
 * SDK keeps its device id and its unflushed queue, and this site its consent
 * record), a sessionStorage that lives as long as the tab (where the visit id
 * lives), and everything the ingest host actually received.
 */
function openTab() {
  return {
    local: new Map<string, string>(),
    session: new Map<string, string>(),
    cookies: new Map<string, string>(),
    events: [] as WireEvent[],
    logs: [] as WireLog[],
  };
}

type Tab = ReturnType<typeof openTab>;

/**
 * One `document.cookie` write, the way the browser applies it: a `name=value` pair
 * plus attributes, where an expiry already in the past (what `max-age=0` means)
 * removes the pair instead of storing it. Domain and path are not modelled - this
 * jar is one document on one host - so a removal aimed at any scope reaches it.
 */
function writeCookie(tab: Tab, entry: string): void {
  const [pair, ...attributes] = entry.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const name = separator === -1 ? pair : pair.slice(0, separator);
  if (attributes.some((attribute) => /^max-age=(0|-)/i.test(attribute))) {
    tab.cookies.delete(name);
    return;
  }
  tab.cookies.set(name, pair.slice(separator + 1));
}

const storageOf = (map: Map<string, string>) => ({
  getItem: (key: string): string | null => map.get(key) ?? null,
  setItem: (key: string, value: string): void => void map.set(key, value),
  removeItem: (key: string): void => void map.delete(key),
});

const ingestInto =
  (tab: Tab) =>
  (_url: string, init: { body: string }): Promise<{ ok: boolean; status: number }> => {
    const payload = JSON.parse(init.body) as { events?: WireEvent[]; logs?: WireLog[] };
    tab.events.push(...(payload.events ?? []));
    tab.logs.push(...(payload.logs ?? []));
    return Promise.resolve({ ok: true, status: 200 });
  };

/** The `<script>` elements a page load appended to `document.head`. */
type AppendedScript = { src?: string; async?: boolean };

/** The two queues Google's tags read from this page: the ad tag's, and gtag's. */
interface GoogleTagWindow {
  adsbygoogle?: { requestNonPersonalizedAds?: number };
  dataLayer?: unknown[];
}

/**
 * Every `gtag('consent', …)` command queued on this page. A Consent Mode signal
 * is inert until a Google tag library drains `dataLayer`, and this site loads one
 * only behind the analytics grant - so an ad-storage denial pushed there proves
 * nothing about what the ad partner was allowed to do. The ads gate has to hold
 * on which scripts it requested, and this is here to assert it never leaned on
 * the queue instead.
 */
function queuedConsentSignals(window: GoogleTagWindow): unknown[] {
  return gtagCommands(window).filter((args) => args[0] === 'consent');
}

/**
 * Every gtag command this page queued, as `[command, ...args]`. gtag.js is a
 * `dataLayer.push(arguments)` shim, so the queue *is* what the tag will send -
 * reading it is how a hit is asserted without executing Google's script.
 */
const gtagCommands = (window: GoogleTagWindow): unknown[][] =>
  (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));

/** The hits queued for GA4, in the order the tag would send them. */
const gtagEvents = (
  window: GoogleTagWindow,
): { name: string; params: Record<string, unknown> }[] =>
  gtagCommands(window)
    .filter((args) => args[0] === 'event')
    .map((args) => ({
      name: String(args[1]),
      params: (args[2] ?? {}) as Record<string, unknown>,
    }));

const gtagEventNames = (window: GoogleTagWindow): string[] =>
  gtagEvents(window).map((event) => event.name);

/** The parameters the document's one `gtag('config', ...)` command carries. */
function gtagConfig(window: GoogleTagWindow): Record<string, unknown> {
  const configs = gtagCommands(window).filter((args) => args[0] === 'config');
  assert.equal(configs.length, 1, 'expected exactly one gtag config per document');
  return (configs[0][2] ?? {}) as Record<string, unknown>;
}

/**
 * Open a document on `path` in `tab`: a fresh `window` - and so, for a correctly
 * scoped module, a fresh analytics state - over the tab's storage, plus the
 * transport that records what the ingest host received.
 *
 * Called again on the same tab to model the next page load: a redirect's
 * destination, a reload, a navigation to another page of the site.
 */
function loadPage(
  tab: Tab,
  path: string,
): { scripts: AppendedScript[]; window: GoogleTagWindow } {
  const localStorage = storageOf(tab.local);
  const sessionStorage = storageOf(tab.session);
  const scripts: AppendedScript[] = [];
  const window = {
    localStorage,
    sessionStorage,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  const document = {
    // No `data-theme`: the light default, as on a page the visitor has not switched.
    documentElement: { getAttribute: (): string | null => null },
    head: { appendChild: (node: AppendedScript): void => void scripts.push(node) },
    createElement: (): AppendedScript => ({}),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    referrer: '',
    visibilityState: 'visible',
    get cookie(): string {
      return [...tab.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set cookie(entry: string) {
      writeCookie(tab, entry);
    },
  };
  Object.assign(globalThis, {
    window,
    document,
    localStorage,
    sessionStorage,
    fetch: ingestInto(tab),
  });
  navigateTo(path);
  return { scripts, window };
}

/** Point `location` at `path` without replacing the document, as history.pushState does. */
function navigateTo(path: string): void {
  Object.assign(globalThis, {
    location: {
      pathname: path,
      href: `https://sleekdrops.com${path}`,
      origin: 'https://sleekdrops.com',
      hostname: 'sleekdrops.com',
      protocol: 'https:',
    },
  });
}

/** The analytics state the current document is actually using. */
const documentScope = (): AnalyticsScope<AnalyticsClient, string> | undefined =>
  (globalThis.window as unknown as { __sdAnalytics?: AnalyticsScope<AnalyticsClient, string> })
    .__sdAnalytics;

/**
 * This document's client, reached the only way anything outside the module can
 * reach it - through the document-scoped state. That it is reachable there at all
 * is the property the singleton guard rests on.
 */
function documentClient(): AnalyticsClient {
  const scope = documentScope();
  assert.ok(scope, 'the analytics state must hang off the document, not the module');
  assert.ok(scope.client, 'expected this document to have created a client');
  return scope.client;
}

const flush = (): Promise<void> => documentClient().flush();
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for an asynchronous settle - a shutdown's trailing cleanup, say - to happen. */
async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
}

const names = (tab: Tab): string[] => tab.events.map((event) => event.name);
const distinct = (values: unknown[]): unknown[] => [...new Set(values)];
const countOf = (tab: Tab, name: string): number =>
  names(tab).filter((value) => value === name).length;
const logsSaying = (tab: Tab, text: string): WireLog[] =>
  tab.logs.filter((entry) => entry.body.includes(text));
const sdkKeys = (tab: Tab): string[] =>
  [...tab.local.keys()].filter((key) => key.startsWith(SDK_KEY_PREFIX));

const ga4Tags = (scripts: AppendedScript[]): AppendedScript[] =>
  scripts.filter((script) => String(script.src).includes('googletagmanager.com'));

const adPartnerTags = (scripts: AppendedScript[]): AppendedScript[] =>
  scripts.filter((script) => String(script.src).includes('adsbygoogle.js'));

/**
 * The measurement id the document's GA4 tag was actually loaded with, read off the
 * tag rather than restated here - it is the id the opt-out flag has to name, and a
 * flag naming any other property is a flag gtag.js never reads.
 */
function ga4MeasurementId(scripts: AppendedScript[]): string {
  const tag = ga4Tags(scripts)[0];
  assert.ok(tag?.src, 'expected the document to have loaded a GA4 tag');
  return new URL(tag.src).searchParams.get('id') ?? '';
}

/** gtag.js's per-property kill switch, as the tag itself would read it. */
const gaOptOut = (measurementId: string): unknown =>
  (globalThis.window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`];

/**
 * The identifier cookies gtag.js writes once it is running. The harness records the
 * tag by src rather than executing Google's script, so its cookies are put in the
 * jar here - shaped as GA4 writes them, `_ga` on the site and `_ga_<container>` for
 * the property.
 */
function gaWritesItsCookies(tab: Tab, measurementId: string): void {
  tab.cookies.set('_ga', 'GA1.1.1234567890.1700000000');
  tab.cookies.set(`_ga_${measurementId.replace('G-', '')}`, 'GS1.1.1700000000.1.0.1700000000.0.0.0');
}

/**
 * Whether a withdrawal has fully settled: the detached client's final flush has
 * delivered the `delivered` events queued under consent, and the empty queue that
 * flush wrote back on its way out has been cleared behind it.
 */
const withdrawalSettled = (tab: Tab, delivered: number): boolean =>
  tab.events.length >= delivered && sdkKeys(tab).length === 0;

/**
 * The events this site emits. `$session_start` is minted inside the SDK and
 * carries no properties at all, so it has neither of the ids this site stamps -
 * it joins to a visit through the `session_id` it shares with the events that do
 * (asserted below).
 */
const ownEvents = (tab: Tab): WireEvent[] =>
  tab.events.filter((event) => event.name !== SESSION_START);
const propOf = (tab: Tab, key: string): unknown[] =>
  ownEvents(tab).map((event) => event.properties?.[key]);

/** Every `$session_start` resolves to a visit through its session id. */
function assertSessionStartsJoinToAVisit(tab: Tab): void {
  const visitOfSession = new Map(
    ownEvents(tab).map((event) => [event.session_id, event.properties?.visit_id]),
  );
  tab.events
    .filter((event) => event.name === SESSION_START)
    .forEach((event) => {
      assert.ok(
        visitOfSession.get(event.session_id),
        `${SESSION_START} must be joinable to a visit through its session_id`,
      );
    });
}

/**
 * The module narrates itself to the browser console, every line prefixed
 * `[analytics]`. Captured rather than printed: it keeps the runner's output
 * readable, and it is the only place the deny path's announcement is observable
 * (by design - it detaches the client before it says anything, so the line has no
 * platform sink left to reach).
 */
const consoleLines: string[] = [];
type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';
const realConsole = new Map<ConsoleMethod, (...args: unknown[]) => void>();
(['debug', 'info', 'warn', 'error'] as ConsoleMethod[]).forEach((name) => {
  realConsole.set(name, console[name]);
  console[name] = (...args: unknown[]): void => void consoleLines.push(args.map(String).join(' '));
});
after(() => {
  realConsole.forEach((method, name) => {
    console[name] = method;
  });
});

const linesSaying = (text: string): string[] =>
  consoleLines.filter((line) => line.includes(text));

beforeEach(() => {
  consoleLines.length = 0;
});

test('REPRODUCTION: two loads in one visit are what produced the reported four events', async () => {
  // The SDK on its own, with none of this site's guards and no visit id: the shape
  // the platform recorded.
  const tab = openTab();
  loadPage(tab, '/');
  let clock = 1_700_000_000_000;
  const rawClient = (): AnalyticsClient =>
    createAnalytics({
      key: 'dtp_test',
      host: 'http://analytics.test',
      storage: storageOf(tab.local),
      fetch: ingestInto(tab),
      now: () => clock,
      trackPageviews: false,
      autoCaptureErrors: false,
    });

  const first = rawClient();
  first.track(PAGE_VIEW, { path: '/' });
  await tick();
  // Nothing has been delivered yet: the SDK flushes at 20 events or every 5s, so
  // the first load's events are sitting in localStorage when the second starts.
  assert.deepEqual(tab.events, []);

  clock += 300;
  const second = rawClient();
  second.track(PAGE_VIEW, { path: '/' });
  await tick();
  await second.flush();

  // The reported signature, exactly - including the interleaved order, which is
  // the restored queue landing in front of the new load's own events.
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW, SESSION_START, PAGE_VIEW]);
  assert.equal(distinct(tab.events.map((event) => event.session_id)).length, 2);
  await first.shutdown();
  await second.shutdown();
});

test('two module copies in one document share one client, and so open one session', async () => {
  const tab = openTab();
  loadPage(tab, '/');

  // The banner island boots and the visitor opts in; the chrome bundle boots too
  // and reads the same decision back.
  assert.equal(banner.boot(), 'banner');
  banner.grantConsent();
  assert.equal(chrome.boot(), 'none');
  chrome.trackPageView({ referrer: '' });
  banner.track(HERO_CTA, { cta: 'Read the latest' });
  await flush();

  assert.equal(
    documentScope(),
    (globalThis.window as unknown as { __sdAnalytics: unknown }).__sdAnalytics,
  );
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW, HERO_CTA]);
  assert.equal(countOf(tab, SESSION_START), 1);
  assert.equal(distinct(tab.events.map((event) => event.session_id)).length, 1);
});

test('a page view buffered by one module copy is flushed by the other, once', async () => {
  const tab = openTab();
  loadPage(tab, '/');

  // chrome.ts dispatches before the visitor has chosen, so the page view waits in
  // the consent buffer - the one both copies have to be looking at.
  chrome.boot();
  chrome.trackPageView({ referrer: '' });
  const buffered = documentScope()?.buffer ?? [];
  assert.equal(buffered.length, 1, 'the page view must be buffered until consent is known');
  const bufferedId = buffered[0]?.props?.event_id;

  banner.grantConsent();
  // A second grant - the visitor re-saving their preferences - must not re-flush it.
  banner.grantConsent();
  chrome.boot();
  await flush();

  assert.equal(countOf(tab, PAGE_VIEW), 1);
  assert.equal(countOf(tab, SESSION_START), 1);
  // The id the event was created with is the id that reached the platform, so a
  // buffered event that is later re-sent still collapses.
  assert.match(String(bufferedId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(propOf(tab, 'event_id'), [bufferedId]);
});

test('the grant path runs once per document, however many entry points call it', async () => {
  const tab = openTab();
  const { scripts } = loadPage(tab, '/');

  chrome.grantConsent();
  banner.grantConsent();
  chrome.boot();
  banner.boot();
  chrome.track(HERO_CTA, { cta: 'Read the latest' });
  await tick();
  await flush();

  assert.equal(countOf(tab, SESSION_START), 1);
  assert.equal(ga4Tags(scripts).length, 1, 'one GA4 tag per document');
  assert.equal(
    logsSaying(tab, 'consent granted').length,
    1,
    'the grant path must run once per document, not once per caller',
  );
});

test('dispatching the page view twice in one document emits one event', async () => {
  const tab = openTab();
  loadPage(tab, '/deals/foo');
  chrome.grantConsent();

  chrome.trackPageView({ referrer: '' });
  chrome.trackPageView({ referrer: '' });
  banner.trackPageView({ referrer: '' });
  await flush();

  assert.equal(countOf(tab, PAGE_VIEW), 1);
  assert.equal(countOf(tab, SESSION_START), 1);
  assert.match(linesSaying('page view already recorded')[0] ?? '', /\/deals\/foo/);
});

test('the guard is per path, so a same-document navigation is still counted', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  chrome.grantConsent();

  chrome.trackPageView({ referrer: '' });
  navigateTo('/deals/foo');
  chrome.trackPageView({ referrer: '' });
  await flush();

  assert.equal(countOf(tab, PAGE_VIEW), 2);
  assert.deepEqual(propOf(tab, 'path'), ['/', '/deals/foo']);
});

test('a slash-suffixed entry URL is one page and one visit across the redirect', async () => {
  const tab = openTab();

  // Load 1: the visitor arrives on the slash-suffixed URL, which 308s to the bare one.
  loadPage(tab, '/deals/foo/');
  banner.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await flush();

  // Load 2: the redirect's destination - a new document in the same tab, which
  // resolves the stored decision rather than asking again.
  loadPage(tab, '/deals/foo');
  assert.equal(chrome.boot(), 'none');
  chrome.trackPageView({ referrer: '' });
  await flush();

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
});

test('every event carries its own idempotency key, through the scrub', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  chrome.grantConsent();

  chrome.trackPageView({ referrer: '' });
  chrome.track(HERO_CTA, { cta: 'Read the latest' });
  banner.track('Share Clicked', { placement: 'article' });
  await flush();

  // Present on every event this site sends - so it survived scrub(), which drops
  // any property not on the allowlist - and never the same value twice.
  const ids = propOf(tab, 'event_id');
  assert.equal(ids.length, 3);
  ids.forEach((id) => assert.match(String(id), /^[0-9a-f-]{36}$/));
  assert.equal(distinct(ids).length, ids.length);
});

test('nothing is stored, and no visit opened, before the visitor consents', async () => {
  const tab = openTab();
  loadPage(tab, '/');

  chrome.boot();
  chrome.trackPageView({ referrer: '' });
  banner.denyConsent();
  chrome.track(HERO_CTA, { cta: 'Read the latest' });
  await tick();

  assert.deepEqual(tab.events, []);
  assert.equal(tab.session.size, 0, 'sd_sid must not exist for a visitor who declined');
  assert.deepEqual([...tab.local.keys()], [CONSENT_KEY], 'the SDK must never have been created');
});

test('a second decline is a no-op, not a second withdrawal', async () => {
  const tab = openTab();
  loadPage(tab, '/');

  chrome.denyConsent();
  banner.denyConsent();
  chrome.boot();
  chrome.trackPageView({ referrer: '' });
  await tick();

  assert.equal(documentScope()?.decision, 'denied');
  assert.deepEqual(tab.events, []);
  assert.equal(
    linesSaying('consent denied').length,
    1,
    'the deny path must run once per document, not once per caller',
  );
});

test('the preferences dialog reads back the decision in force, not the opt-in default', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  assert.equal(chrome.consentStatus(), null, 'nothing is in force before the visitor chooses');

  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();
  assert.equal(banner.consentStatus(), 'granted');

  // The next page load, where the footer control is the only way back in: boot()
  // applies the stored record silently and the banner stays hidden, so the switch
  // the dialog reopens with can only be filled from here.
  loadPage(tab, '/deals');
  assert.equal(banner.boot(), 'none');
  assert.equal(banner.consentStatus(), 'granted');
});

test('the record the banner writes is the record the ads gate reads back', () => {
  // The two categories live in one stored record written here and read by
  // `./ads`, which never imports this module - so the shape they agree on is only
  // asserted where both ends meet: what the real writer wrote, through the real
  // parser the ads gate calls.
  const tab = openTab();
  loadPage(tab, '/');

  // "Accept analytics" is exactly that: it must not hand the visitor's ads
  // decision to the ad partner on the strength of an analytics opt-in.
  chrome.grantConsent();
  const accepted = parseConsent(tab.local.get(CONSENT_KEY) ?? null);
  assert.equal(accepted?.v, POLICY_VERSION);
  assert.deepEqual(accepted?.grants, { analytics: 'granted', ads: 'denied' });

  // "Decline all" declines every category, including the ones added after it was
  // written.
  banner.denyConsent();
  assert.deepEqual(parseConsent(tab.local.get(CONSENT_KEY) ?? null)?.grants, {
    analytics: 'denied',
    ads: 'denied',
  });

  // A per-category save - what the preferences dialog's switches resolve to.
  chrome.setConsent({ analytics: 'denied', ads: 'granted' });
  assert.deepEqual(parseConsent(tab.local.get(CONSENT_KEY) ?? null)?.grants, {
    analytics: 'denied',
    ads: 'granted',
  });
  assert.equal(chrome.consentStatus(), 'denied', 'an ads grant is not an analytics grant');
});

test('the ad partner is loaded only for a visitor who saved the advertising opt-in', () => {
  // The consent dialog's own path, end to end: its Save writes through
  // setConsent() here, and a page unit then asks `./ads` - which never imports
  // this module - what it may show. Only an explicit advertising opt-in gets the
  // partner script at all: the tag writes its own cookies and device storage as
  // soon as it runs, so no other state may fetch it.
  const tab = openTab();
  const first = loadPage(tab, '/');

  // "Accept analytics" on the banner: an analytics opt-in is not an ads opt-in,
  // so no ad tag is requested on this page - and the analytics grant, which is
  // what loads gtag.js, does not turn one into the other.
  chrome.grantConsent();
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.loadAds(), false);
  assert.deepEqual(adPartnerTags(first.scripts), [], 'no ad tag on an analytics-only grant');
  assert.equal(first.window.adsbygoogle?.requestNonPersonalizedAds, 1);
  assert.deepEqual(
    queuedConsentSignals(first.window),
    [],
    'and the gate does not rest on a Consent Mode signal',
  );

  // The dialog saved with the Advertising switch on, on the page after it.
  const opted = loadPage(tab, '/deals');
  chrome.setConsent({ analytics: 'granted', ads: 'granted' });
  assert.equal(ads.isAdsGranted(), true);
  assert.equal(ads.loadAds(), true);
  assert.equal(adPartnerTags(opted.scripts).length, 1, 'the opt-in is what loads the partner');
  assert.equal(opted.window.adsbygoogle?.requestNonPersonalizedAds, undefined);

  // The dialog saved with the Advertising switch turned back off: an explicit
  // decline written through the Save path rather than through Decline all.
  const withdrawn = loadPage(tab, '/guides');
  chrome.setConsent({ analytics: 'granted', ads: 'denied' });
  assert.equal(ads.isAdsGranted(), false, 'a saved decline is a decline');
  assert.equal(ads.loadAds(), false);
  assert.deepEqual(adPartnerTags(withdrawn.scripts), [], 'the tag goes with the opt-in');
  assert.equal(withdrawn.window.adsbygoogle?.requestNonPersonalizedAds, 1);

  // "Decline all", on the page after that: no partner either way.
  const declined = loadPage(tab, '/about');
  banner.denyConsent();
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.loadAds(), false);
  assert.deepEqual(adPartnerTags(declined.scripts), []);
  assert.deepEqual(queuedConsentSignals(declined.window), []);
});

test('a consent record written under the previous policy re-prompts and keeps buffering', async () => {
  // What every returning visitor hits on the deploy that adds the ads category:
  // a `{ v: 1, status: 'granted' }` record, written before categories existed.
  const tab = openTab();
  tab.local.set(CONSENT_KEY, JSON.stringify({ v: 1, status: 'granted', ts: 1 }));
  loadPage(tab, '/');

  // Re-prompted rather than silently re-granted, and rather than shown the
  // first-visit banner as if they had never decided.
  assert.equal(banner.boot(), 'policy-update');
  chrome.trackPageView({ referrer: '' });
  await tick();
  assert.deepEqual(tab.events, [], 'a stale record grants nothing until it is renewed');

  // Renewing it flushes what was held, exactly as a first-visit grant does.
  banner.grantConsent();
  await flush();
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW]);
});

test('withdrawing on a later page load stops analytics and holds on the one after it', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();

  loadPage(tab, '/deals');
  banner.boot();
  banner.trackPageView({ referrer: '' });
  await flush();

  // What Save does with the analytics switch turned back off in a dialog reopened
  // from the footer.
  banner.denyConsent();
  await until(() => sdkKeys(tab).length === 0, 'the withdrawal never cleared the SDK storage');
  assert.equal(chrome.consentStatus(), 'denied');

  loadPage(tab, '/contact');
  assert.equal(chrome.boot(), 'none');
  assert.equal(chrome.consentStatus(), 'denied');
  chrome.trackPageView({ referrer: '' });
  await tick();
  assert.equal(documentScope()?.client, null, 'a visitor who withdrew gets no client');
  assert.deepEqual(
    propOf(tab, 'path').filter((path) => path === '/contact'),
    [],
    'a visitor who withdrew must not be counted on the next page',
  );
  assert.deepEqual([...tab.session.keys()], [], 'and no visit id survives the withdrawal');
});

test('withdrawal leaves no analytics storage behind, not even from its own log line', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();
  assert.ok(sdkKeys(tab).length > 0, 'expected the SDK to have persisted its queue and device id');

  banner.denyConsent();
  await until(() => withdrawalSettled(tab, 2), 'the withdrawal never settled');

  // Nothing on disk for a later load to restore: not the device id, not the
  // undelivered batch, not the visit id - and the deny path's own log line cannot
  // put the queue back, because the client it would go through is already gone.
  // Checking the whole keyspace rather than a restated list of keys is what makes
  // a key added or renamed upstream fail here instead of passing silently.
  assert.deepEqual([...tab.local.keys()], [CONSENT_KEY]);
  assert.deepEqual([...tab.session.keys()], []);
  // The batch queued while consent was live is delivered by the final flush
  // rather than left on disk to be re-sent on some later page load.
  assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW]);
});

test('withdrawal stops the GA4 tag too, not only the DevTeam sink', async () => {
  // Reachable now that the footer control can reopen the dialog over a page that
  // already granted: withdrawing cannot unload gtag.js - the script is in the DOM
  // and window.gtag stays callable - so anything short of its own opt-out flag
  // leaves it emitting (user_engagement on every visibility change and unload, plus
  // the property's enhanced measurement) and holding its identifier cookie for the
  // rest of the document.
  const tab = openTab();
  const { scripts } = loadPage(tab, '/');
  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();
  const measurementId = ga4MeasurementId(scripts);
  gaWritesItsCookies(tab, measurementId);

  banner.denyConsent();
  await until(() => sdkKeys(tab).length === 0, 'the withdrawal never cleared the SDK storage');

  assert.equal(gaOptOut(measurementId), true, 'the tag must be told to stop sending');
  assert.deepEqual([...tab.cookies.keys()], [], 'and must not keep identifying the visitor');
});

test('opting back in re-enables the GA4 tag the withdrawal switched off', async () => {
  // The tag is only loaded once per document, so nothing on the re-grant path would
  // clear a stale opt-out flag: a visitor who withdrew and changed their mind would
  // go uncounted in GA4 for the rest of the page while believing they opted in.
  const tab = openTab();
  const { scripts } = loadPage(tab, '/');
  chrome.grantConsent();
  const measurementId = ga4MeasurementId(scripts);
  banner.denyConsent();
  await until(() => sdkKeys(tab).length === 0, 'the withdrawal never cleared the SDK storage');
  assert.equal(gaOptOut(measurementId), true);

  chrome.grantConsent();

  assert.equal(gaOptOut(measurementId), false);
  assert.equal(ga4Tags(scripts).length, 1, 'one GA4 tag per document');
});

test('opting back in after a withdrawal sends again, on a fresh client', async () => {
  const tab = openTab();
  const { scripts } = loadPage(tab, '/');
  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();
  banner.denyConsent();
  await until(() => withdrawalSettled(tab, 2), 'the withdrawal never settled');
  tab.events.length = 0;

  // A stopped client accepts no further events, so re-consent has to build a new
  // one - which detaching it on withdrawal is what makes possible.
  chrome.grantConsent();
  chrome.track(HERO_CTA, { cta: 'Read the latest' });
  await flush();

  assert.deepEqual(names(tab), [SESSION_START, HERO_CTA]);
  // The second trip through the grant path must not re-tag the document either:
  // GA4 counts a second tag's page as a second page.
  assert.equal(ga4Tags(scripts).length, 1, 'one GA4 tag per document');
});

test('opting back in while the final flush is still in flight keeps the new client whole', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  chrome.grantConsent();
  chrome.trackPageView({ referrer: '' });
  await tick();

  // Withdraw and immediately change your mind - inside the window where the
  // stopped client's last flush has not settled yet. The cleanup that trails that
  // flush must not delete the storage the new client has already written.
  banner.denyConsent();
  chrome.grantConsent();
  chrome.track(HERO_CTA, { cta: 'Read the latest' });
  await delay(25);
  await flush();

  assert.ok(
    tab.local.has(`${SDK_KEY_PREFIX}distinct_id`),
    'the re-consented visitor must keep the device id their new client wrote',
  );
  assert.equal(countOf(tab, HERO_CTA), 1);
});

/**
 * chrome.ts sets the page up the moment it is imported, so it is read as text
 * rather than imported - the approach hero-cta.test.ts and nav-experiment.test.ts
 * already use for the files a test cannot execute. It is the one entry point that
 * dispatches the page view, and going around trackPageView() would go around the
 * one-per-document guard the tests above hold it to.
 */
test('chrome.ts dispatches the page view only through the guarded entry point', () => {
  const chromeSource = readFileSync(
    fileURLToPath(new URL('../scripts/chrome.ts', import.meta.url)),
    'utf8',
  );
  assert.match(chromeSource, /\btrackPageView\(/);
  assert.doesNotMatch(
    chromeSource,
    /\btrack\(\s*EVENTS\.pageView/,
    'the page view must go through trackPageView, which holds the one-per-document guard',
  );
});

/**
 * The GA4 sink, asserted on the queue gtag.js actually sends from.
 *
 * Everything below matters because GA4 answers a hit it cannot use with a 2xx
 * and drops it: a mis-named event, a `$`-prefixed parameter and a property that
 * was never configured all look identical in the browser, and identical to a
 * working integration, surfacing only as a report that stays empty.
 */

test('every tracked event reaches GA4, under the name GA4 can count', async () => {
  // The gap this closes: GA4 used to receive the `config` page view and nothing
  // else, so the outbound affiliate click - the site's primary conversion - was
  // measurable in DevTeam and entirely absent from GA4.
  const tab = openTab();
  const { window } = loadPage(tab, '/deals/foo');
  chrome.grantConsent();

  chrome.track('Affiliate Link Clicked', {
    slug: 'a-deal',
    placement: 'sidebar',
    position: 2,
    // Dropped by the PII scrub before either sink sees it, so its absence from
    // GA4 is the scrub holding rather than the GA4 mapping hiding it.
    email: 'someone@example.com',
  });
  chrome.track('Theme Toggled', { theme: 'dark' });
  await flush();

  assert.deepEqual(gtagEventNames(window), ['affiliate_link_clicked', 'theme_toggled']);
  const click = gtagEvents(window)[0].params;
  assert.equal(click.slug, 'a-deal');
  assert.equal(click.placement, 'sidebar');
  assert.equal(click.position, 2);
  assert.equal(click.send_to, ga4Property, 'the hit must name the property it is for');
  assert.equal(click.email, undefined, 'the scrub runs before both sinks, not after one');
  // Both sinks were fed from the one scrubbed payload, so they cannot disagree.
  assert.deepEqual(names(tab), [SESSION_START, 'Affiliate Link Clicked', 'Theme Toggled']);
});

test('the page view reaches GA4 once, as GA4 own page_view', async () => {
  // `config` would send a page view of its own, and the site dispatches one that
  // carries the screen, slug and brand. Two would be a page counted twice; the
  // bare one alone would be a page counted without any of its dimensions.
  const tab = openTab();
  const { window } = loadPage(tab, '/deals/foo');
  chrome.grantConsent();

  chrome.trackPageView({ referrer: '', screen: 'deal-detail', slug: 'a-deal' });
  chrome.trackPageView({ referrer: '', screen: 'deal-detail', slug: 'a-deal' });
  await flush();

  assert.equal(gtagConfig(window).send_page_view, false, 'the tag must not send its own');
  assert.deepEqual(gtagEventNames(window), ['page_view']);
  const view = gtagEvents(window)[0].params;
  assert.equal(view.screen, 'deal-detail');
  assert.equal(view.slug, 'a-deal');
  assert.equal(view.path, '/deals/foo');
});

test('a page view buffered before consent still reaches GA4 when it is granted', async () => {
  // The banner-accept path: the view is recorded before the tag exists, and the
  // grant loads the tag and then drains the buffer. An order that drained first
  // would lose the site's only page view for that document in GA4.
  const tab = openTab();
  const { window } = loadPage(tab, '/');

  chrome.boot();
  chrome.trackPageView({ referrer: '', screen: 'home' });
  assert.deepEqual(gtagEventNames(window), [], 'nothing may reach GA4 before consent');

  banner.grantConsent();
  await flush();

  assert.deepEqual(gtagEventNames(window), ['page_view']);
});

test('GA4 is told the normalized page, never the raw query string', async () => {
  // GA4 would otherwise auto-capture location.href and document.referrer
  // verbatim. `config` parameters apply to every later event from the tag, so
  // one override covers the whole document rather than only the first hit.
  const tab = openTab();
  const { window } = loadPage(tab, '/deals/foo');
  Object.assign(globalThis.location, {
    href: 'https://sleekdrops.com/deals/foo/?utm_term=someone%40example.com&q=secret',
  });
  chrome.grantConsent();

  const config = gtagConfig(window);
  assert.equal(config.page_location, 'https://sleekdrops.com/deals/foo');
  assert.equal(config.page_referrer, '', 'a direct visit is reported as one');
});

test('an experiment stamp survives the rename GA4 forces on it', async () => {
  // `$exp_*` is the shape the platform stamps and the shape GA4 rejects outright.
  // Without the rename every experiment on the site would be measurable in
  // DevTeam and invisible in GA4 - with nothing anywhere looking broken.
  const tab = openTab();
  const { window } = loadPage(tab, '/');
  chrome.grantConsent();

  chrome.track('$experiment_viewed', {
    experiment_key: 'hero_cta_copy',
    variant_key: 'treatment',
  });
  await flush();

  assert.deepEqual(gtagEventNames(window), ['experiment_viewed']);
  assert.equal(gtagEvents(window)[0].params.experiment_key, 'hero_cta_copy');
});

test('a build with no measurement id tags the document with nothing', async () => {
  // The state every local `pnpm dev` is in, and the state an environment is in
  // before its property exists. It has to cost the page nothing at all: no
  // third-party script, no `_ga` cookie, and no effect on the other sink.
  await noGa4Property(async () => {
    const tab = openTab();
    const { scripts, window } = loadPage(tab, '/');
    chrome.grantConsent();
    chrome.trackPageView({ referrer: '', screen: 'home' });
    await flush();

    assert.deepEqual(ga4Tags(scripts), [], 'no measurement id means no gtag.js');
    assert.deepEqual(gtagCommands(window), []);
    assert.deepEqual(names(tab), [SESSION_START, PAGE_VIEW], 'the DevTeam sink is unaffected');
    assert.equal(
      logsSaying(tab, 'GA4 NOT configured').length,
      1,
      'and the reason is said once, not left to be inferred from an empty report',
    );
  });
});

test('GA4 still counts when the DevTeam sink is the one left unconfigured', async () => {
  // The mirror image, and the reason the GA4 forward sits outside the client
  // guard in send(): an empty ingest key is a supported state that disables one
  // sink, and reading it as "send nothing anywhere" would leave a correctly
  // configured GA4 property receiving not one funnel event.
  await noDevteamKey(async () => {
    const tab = openTab();
    const { scripts, window } = loadPage(tab, '/');
    chrome.grantConsent();
    chrome.trackPageView({ referrer: '', screen: 'home' });
    chrome.track(HERO_CTA, { cta: 'Read the latest' });

    assert.equal(ga4Tags(scripts).length, 1);
    assert.deepEqual(gtagEventNames(window), ['page_view', 'hero_cta_clicked']);
    assert.deepEqual(tab.events, [], 'and nothing was sent to the sink that has no key');
  });
});
