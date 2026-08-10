/**
 * The regression suite for the third thing a consent withdrawal has to stop: A/B
 * testing.
 *
 * Grant-then-withdraw inside one document only became reachable when the footer
 * preferences control shipped, and the withdrawal path was written for the two
 * analytics sinks. The A/B testing SDK was left running: an open subscription to
 * the flag host, a 60s payload poll, and - the part the visitor can actually see
 * in their own storage - a live GrowthBook instance whose tracking callback still
 * bucketed them and wrote `sd-exp` on the next feature read. Reads after a
 * withdrawal are routine rather than hypothetical: `chrome.ts` re-reads every
 * experiment-backed slot on each payload change and every time the nav crosses
 * its 900px breakpoint, so a visitor who withdraws on a phone-width page and then
 * rotates is bucketed after opting out.
 *
 * Everything here drives the **shipped** `./analytics` and `./experiments`
 * modules against the **real** `@growthbook/growthbook` SDK, so a guard removed
 * from either module fails a test rather than passing against a stand-in. What is
 * substituted is what cannot exist outside a Vite build (the two `import.meta.env`
 * seams, `./analytics-env` and `./flags-env`) and the browser itself: storage, the
 * `window.setInterval` the poll is armed with, `fetch` - which answers both the
 * flag host and the ingest host - and `EventSource`, which is how the SDK holds
 * the stream this suite watches open and closed.
 *
 * A/B testing state is module-level rather than document-level - one instance per
 * page load, by construction - so a withdrawal is the only reset there is. Every
 * test therefore ends withdrawn, and the regression itself is the first test in
 * the file, so that a broken withdrawal fails on its own assertion rather than on
 * a page the test after it could no longer set up.
 *
 * Run it with `pnpm --filter @sleekdrops/web test`: substituting the env seams
 * needs node's `--experimental-test-module-mocks`, which that script passes.
 */

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalyticsClient } from '@getdevteam/analytics-web';

import type { AnalyticsScope } from './analytics-scope.ts';

const INGEST_HOST = 'http://analytics.test';
const FLAG_HOST = 'https://flags.test';

/** The site's own feature keys, as `index.astro` and `Header.astro` read them. */
const HERO_COPY = 'hero_cta_copy';
const NAV_ITEM = 'remove-about-page';

const HERO_DEFAULT = 'Read the latest';
const STICKY_KEY = 'sd-exp';

/**
 * A payload in which **both** features are experiment-backed at full coverage, so
 * a first read of either one buckets the visitor and fires the tracking callback.
 * That is what makes the post-withdrawal read below a real test: the read would
 * write a stamp if anything were still listening.
 */
const FLAG_PAYLOAD = {
  features: {
    [HERO_COPY]: {
      defaultValue: HERO_DEFAULT,
      rules: [
        {
          key: HERO_COPY,
          variations: [HERO_DEFAULT, 'Browse the archive'],
          meta: [{ key: 'control' }, { key: 'b' }],
          weights: [0.5, 0.5],
          coverage: 1,
          hashAttribute: 'id',
        },
      ],
    },
    [NAV_ITEM]: {
      defaultValue: false,
      rules: [
        {
          key: NAV_ITEM,
          variations: [false, true],
          meta: [{ key: 'control' }, { key: 'b' }],
          weights: [0.5, 0.5],
          coverage: 1,
          hashAttribute: 'id',
        },
      ],
    },
  },
};

/**
 * The client key the flag host is asked for, swapped per test. The SDK caches a
 * payload in module-level state keyed by host and client key, so a fresh key is
 * what keeps one test's fetches and streams out of the next one's.
 */
let clientKey = '';

mock.module(new URL('./analytics-env.ts', import.meta.url).href, {
  namedExports: { analyticsEnv: () => ({ key: 'dtp_test', host: INGEST_HOST }) },
});
mock.module(new URL('./flags-env.ts', import.meta.url).href, {
  namedExports: { flagsEnv: () => ({ apiHost: FLAG_HOST, clientKey }) },
});

const analytics = await import('./analytics.ts');
const { getFeatureValue, stickyProps } = await import('./experiments.ts');

/** One request the SDK made to the flag host, and how it was answered. */
interface FlagRequest {
  url: string;
  /** Held open until `release()` is called, modelling a slow platform. */
  release: () => void;
}

const flagRequests: FlagRequest[] = [];

/**
 * Every subscription the SDK opened to the flag host. `EventSource` is not a node
 * global, so without this the streaming half of the SDK would quietly do nothing
 * and the property under test - that a withdrawal closes the stream - could not
 * be observed at all.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  url: string;
  closed = false;
  readyState = 1;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

const openStreams = (): FakeEventSource[] =>
  FakeEventSource.opened.filter((stream) => !stream.closed);

/**
 * The `window.setInterval` timers this page has running - the module arms exactly
 * one, the payload staleness poll. Recorded rather than run on a real clock so a
 * test can both see that the poll is armed and fire it on demand; a 60s wait is
 * not a test.
 */
const polls = new Map<number, () => void>();
let nextPollId = 1;
const runPolls = (): void => polls.forEach((poll) => poll());

interface WireEvent {
  name: string;
  properties?: Record<string, unknown>;
}

/** One browser tab: storage that outlives a page load, and what the ingest host got. */
function openTab() {
  return {
    local: new Map<string, string>(),
    session: new Map<string, string>(),
    events: [] as WireEvent[],
  };
}

type Tab = ReturnType<typeof openTab>;

const storageOf = (map: Map<string, string>) => ({
  getItem: (key: string): string | null => map.get(key) ?? null,
  setItem: (key: string, value: string): void => void map.set(key, value),
  removeItem: (key: string): void => void map.delete(key),
});

/**
 * The one `fetch` both SDKs are given. GrowthBook binds `globalThis.fetch` once,
 * when its chunk is first imported, so a per-page swap would never reach it -
 * this stays the same function for the life of the run and routes by host.
 */
function routeFetch(tab: Tab) {
  return (url: string, init?: { body?: string }): Promise<unknown> => {
    if (String(url).startsWith(FLAG_HOST)) {
      return new Promise((resolve) => {
        flagRequests.push({
          url: String(url),
          release: () =>
            resolve(
              new Response(JSON.stringify(FLAG_PAYLOAD), {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-sse-support': 'enabled' },
              }),
            ),
        });
      });
    }
    const payload = JSON.parse(init?.body ?? '{}') as { events?: WireEvent[] };
    tab.events.push(...(payload.events ?? []));
    return Promise.resolve({ ok: true, status: 200 });
  };
}

let currentTab: Tab = openTab();

/** Answer every flag request made so far, in the order the SDK made them. */
const serveFlags = (): void => flagRequests.forEach((request) => request.release());

/**
 * Open a document on `path` in `tab`: a fresh `window`, and so a fresh analytics
 * state, over the tab's storage. The A/B testing state is module-level rather than
 * document-level (one instance per page load, by construction), so a test that
 * wants it clean withdraws first - which is the behaviour under test anyway.
 */
function loadPage(tab: Tab, path: string): void {
  currentTab = tab;
  const localStorage = storageOf(tab.local);
  const sessionStorage = storageOf(tab.session);
  polls.clear();
  const window = {
    localStorage,
    sessionStorage,
    setInterval: (poll: () => void): number => {
      const id = nextPollId++;
      polls.set(id, poll);
      return id;
    },
    clearInterval: (id: number): void => void polls.delete(id),
    setTimeout: (callback: () => void, ms?: number): NodeJS.Timeout => setTimeout(callback, ms),
    clearTimeout: (id: NodeJS.Timeout): void => clearTimeout(id),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    location: { href: `https://sleekdrops.com${path}`, protocol: 'https:' },
  };
  const document = {
    // No `data-theme`: the light default, as on a page the visitor has not switched.
    documentElement: { getAttribute: (): string | null => null },
    head: { appendChild: (): void => {} },
    createElement: (): Record<string, unknown> => ({}),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    referrer: '',
    visibilityState: 'visible',
    cookie: '',
  };
  Object.assign(globalThis, {
    window,
    document,
    localStorage,
    sessionStorage,
    location: {
      pathname: path,
      href: `https://sleekdrops.com${path}`,
      origin: 'https://sleekdrops.com',
      hostname: 'sleekdrops.com',
      protocol: 'https:',
    },
  });
}

// GrowthBook pulls in dom-mutator, which attaches a global observer the moment it
// is imported into anything with a `document`, and captures `fetch` / `EventSource`
// in the same breath. All three have to exist before the first grant loads it.
Object.assign(globalThis, {
  MutationObserver: class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  },
  EventSource: FakeEventSource,
  fetch: (url: string, init?: { body?: string }): Promise<unknown> =>
    routeFetch(currentTab)(url, init),
});

const scope = (): AnalyticsScope<AnalyticsClient, string> | undefined =>
  (globalThis.window as unknown as { __sdAnalytics?: AnalyticsScope<AnalyticsClient, string> })
    .__sdAnalytics;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
}

/** The stamp this visitor carries for `experimentKey`, or null if they carry none. */
const stampFor = (experimentKey: string): unknown =>
  (stickyProps() as Record<string, unknown>)[`$exp_${experimentKey}`] ?? null;

/** The stamps as they were written to disk, which is what a later page load reads back. */
const storedStamps = (tab: Tab): Record<string, unknown> =>
  JSON.parse(tab.local.get(STICKY_KEY) ?? '{}') as Record<string, unknown>;

/**
 * Opt in, and wait until the visitor is actually bucketed: the grant path takes
 * the distinct id from the SDK's storage restore a macrotask later, then imports
 * the SDK chunk and fetches the payload, and only a feature read after all of that
 * assigns a variant. Reading in the loop is what a subscriber in `chrome.ts` does
 * on every payload change.
 */
async function grantAndBucket(): Promise<void> {
  analytics.grantConsent();
  await until(() => {
    serveFlags();
    getFeatureValue(HERO_COPY, HERO_DEFAULT);
    return stampFor(HERO_COPY) !== null;
  }, 'the visitor was never bucketed into the hero experiment');
}

/**
 * Both modules narrate themselves to the browser console, every line prefixed
 * `[analytics]`. Captured rather than printed, so the runner's output stays
 * readable; nothing here asserts on it.
 */
const consoleLines: string[] = [];
const realConsole = new Map<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>();
(['debug', 'info', 'warn', 'error'] as const).forEach((level) => {
  realConsole.set(level, console[level]);
  console[level] = (...args: unknown[]): void => void consoleLines.push(args.map(String).join(' '));
});
after(() => {
  realConsole.forEach((method, level) => {
    console[level] = method;
  });
});

let testIndex = 0;

beforeEach(() => {
  testIndex += 1;
  // A fresh client key per test: the SDK caches a payload, and holds its stream,
  // in module-level state keyed by host and client key.
  clientKey = `sdk-test-${testIndex}`;
  flagRequests.length = 0;
  FakeEventSource.opened.length = 0;
  consoleLines.length = 0;
});

test('withdrawing stops A/B testing where it stands: no stream, no poll, no bucketing', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  await grantAndBucket();
  // The state a withdrawal has to undo, asserted before it happens so nothing
  // below can pass because the visitor was never bucketed in the first place.
  assert.ok(stampFor(HERO_COPY));
  assert.ok(tab.local.has(STICKY_KEY));
  assert.equal(openStreams().length, 1);
  assert.equal(polls.size, 1);

  // What Save does with the analytics switch turned back off in the dialog the
  // footer control reopens.
  analytics.denyConsent();

  assert.deepEqual(openStreams(), [], 'the subscription to the flag host must be closed');
  assert.equal(polls.size, 0, 'and the payload poll must be cleared');
  const flagRequestsAtWithdrawal = flagRequests.length;
  runPolls();
  assert.equal(
    flagRequests.length,
    flagRequestsAtWithdrawal,
    'nothing may reach the flag host after a withdrawal',
  );

  // The read the report reproduced: a first read of a second experiment-backed
  // feature - what a rotation past the 900px nav breakpoint does - must return the
  // code-side default rather than bucket the visitor and stamp them again.
  assert.equal(getFeatureValue(NAV_ITEM, false), false);
  assert.equal(getFeatureValue(HERO_COPY, HERO_DEFAULT), HERO_DEFAULT);
  assert.deepEqual(stickyProps(), {}, 'no assignment may survive in memory');
  assert.equal(tab.local.has(STICKY_KEY), false, 'and none may be written back to disk');
});

test('while consent stands the visitor is bucketed, stamped and streamed to', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  await grantAndBucket();

  // Both slots are read on a live page - the hero copy on load, the nav item when
  // the payload arrives - and each read is what buckets the visitor into its own
  // experiment. This is the behaviour the withdrawal above has to take away, and
  // taking it away by breaking it is not a fix.
  getFeatureValue(NAV_ITEM, false);
  assert.ok(stampFor(HERO_COPY), 'the hero read must assign a variant');
  assert.ok(stampFor(NAV_ITEM), 'the nav read must assign a variant');
  assert.deepEqual(Object.keys(storedStamps(tab)).sort(), [`$exp_${HERO_COPY}`, `$exp_${NAV_ITEM}`]);

  // The exposure the platform measures the result on, carrying the same variant.
  await scope()?.client?.flush();
  const exposures = tab.events.filter((event) => event.name === '$experiment_viewed');
  assert.equal(exposures.length, 2);
  assert.deepEqual(
    exposures.map((event) => event.properties?.experiment_key).sort(),
    [HERO_COPY, NAV_ITEM],
  );
  assert.equal(exposures[0]?.properties?.variant_key, stampFor(HERO_COPY));

  assert.equal(openStreams().length, 1, 'the payload is streamed while consent stands');
  assert.equal(openStreams()[0]?.url, `${FLAG_HOST}/sub/${clientKey}`);
  assert.equal(polls.size, 1, 'and polled as the fallback for a stream that does not hold');

  analytics.denyConsent();
});

test('withdrawing while the first payload is still in flight leaves nothing running', async () => {
  const tab = openTab();
  loadPage(tab, '/');
  analytics.grantConsent();
  await until(() => flagRequests.length > 0, 'the payload was never requested');

  // The visitor gets to the footer control before the platform answers. The
  // instance that arrives after them must not become this page's live one.
  analytics.denyConsent();
  serveFlags();
  await delay(20);

  assert.deepEqual(openStreams(), [], 'a stream opened by the late payload must be closed');
  assert.equal(polls.size, 0);
  assert.equal(getFeatureValue(HERO_COPY, HERO_DEFAULT), HERO_DEFAULT);
  assert.deepEqual(stickyProps(), {});
  assert.equal(tab.local.has(STICKY_KEY), false);
});

test('opting back in on the same page buckets the visitor again', async () => {
  // The mirror of the GA4 opt-out flag being cleared on a re-grant: a withdrawal
  // that left the start guard latched would leave a visitor who changed their mind
  // out of every experiment for the rest of the page, while their events carried no
  // variant at all.
  const tab = openTab();
  loadPage(tab, '/');
  await grantAndBucket();
  analytics.denyConsent();
  assert.deepEqual(stickyProps(), {});

  await grantAndBucket();

  assert.ok(stampFor(HERO_COPY), 'a re-consented visitor must be bucketed again');
  assert.deepEqual(Object.keys(storedStamps(tab)), [`$exp_${HERO_COPY}`]);

  analytics.denyConsent();
});
