/**
 * The ad loader, driven the way a page component drives it: a real document with
 * a real stored consent record, and the shipped `./ads` module deciding what -
 * if anything - to put on the page.
 *
 * Everything here asserts against the DOM the module actually produced rather
 * than against an interface of its own, because the things that matter are
 * observable only there: that no partner script is requested - and so no ad
 * cookie or device storage is placed - for a visitor who has not answered the
 * prompt or whose browser blocked the category outright, and that a visitor who
 * declined gets the partner with personalisation switched off rather than on.
 *
 * The module needs two things the bare `node --test` runner cannot give it: the
 * publisher id Vite inlines from `import.meta.env` (substituted through the
 * `./ads-env` seam below, the `analytics.test.ts` pattern), and a browser -
 * `window`, `document` and storage, installed per page load by `loadPage`.
 *
 * Run it with `pnpm --filter @sleekdrops/web test`: substituting the env seam
 * needs node's `--experimental-test-module-mocks`, which that script passes.
 */

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { CONSENT_KEY, POLICY_VERSION, uniformGrants, type ConsentGrants } from './consent.ts';

const PUBLISHER = 'ca-pub-1234567890123456';

/** This build's publisher id, as the env seam reports it. Empty = ads disabled. */
let publisher = PUBLISHER;

mock.module(new URL('./ads-env.ts', import.meta.url).href, {
  namedExports: {
    adsEnv: () => ({
      client: publisher,
      slots: { articleMid: '1', articleEnd: '2', sidebar: '3', feed: '4' },
    }),
  },
});

const ads = await import('./ads.ts');

/** The partner's command queue, with the personalisation flag it carries. */
interface FakeQueue extends Array<unknown> {
  requestNonPersonalizedAds?: number;
}

/** A `<script>` as the module built it, with the properties it chose to set. */
interface FakeScript {
  src?: string;
  async?: boolean;
  crossOrigin?: string;
  /**
   * The personalisation flag as it stood the moment this script was injected.
   * The partner reads the flag off its queue while draining it, so a flag set
   * after injection is a flag that may never be honoured.
   */
  npaWhenInjected?: number;
}

interface FakeWindow {
  localStorage: unknown;
  doNotTrack?: string;
  adsbygoogle?: FakeQueue;
  __sdAds?: unknown;
}

/** A stored consent record, as `./analytics` writes it. */
const stored = (grants: ConsentGrants, v: number = POLICY_VERSION): string =>
  JSON.stringify({ v, grants, ts: 1 });

/** A record written under policy version 1, before the ads category existed. */
const legacyStored = (status: 'granted' | 'denied'): string =>
  JSON.stringify({ v: 1, status, ts: 1 });

/**
 * Open a document carrying `consent` in localStorage: a fresh `window`, and so -
 * for a correctly scoped module - a fresh "have we loaded the partner yet" state,
 * exactly as a navigation to the next page of the site would give it.
 */
function loadPage(consent?: string, browser: { doNotTrack?: string } = {}) {
  const store = new Map<string, string>();
  if (consent) store.set(CONSENT_KEY, consent);
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value),
    removeItem: (key: string): void => void store.delete(key),
  };
  const scripts: FakeScript[] = [];
  const window: FakeWindow = { localStorage, doNotTrack: browser.doNotTrack };
  const document = {
    createElement: (): FakeScript => ({}),
    head: {
      appendChild: (node: FakeScript): void => {
        node.npaWhenInjected = window.adsbygoogle?.requestNonPersonalizedAds;
        scripts.push(node);
      },
    },
  };
  Object.assign(globalThis, { window, document, localStorage });
  return { scripts, window };
}

/** The static build and the test runner both look like this: no DOM at all. */
function closeDocument(): void {
  ['window', 'document', 'localStorage'].forEach((name) => {
    delete (globalThis as Record<string, unknown>)[name];
  });
}

const partnerScripts = (scripts: FakeScript[]): FakeScript[] =>
  scripts.filter((script) => String(script.src).includes('adsbygoogle.js'));

/** The module narrates itself to the console, every line prefixed `[ads]`. */
const consoleLines: string[] = [];
type ConsoleMethod = 'info' | 'warn';
const realConsole = new Map<ConsoleMethod, (...args: unknown[]) => void>();
(['info', 'warn'] as ConsoleMethod[]).forEach((name) => {
  realConsole.set(name, console[name]);
  console[name] = (...args: unknown[]): void => void consoleLines.push(args.map(String).join(' '));
});
after(() => {
  realConsole.forEach((method, name) => {
    console[name] = method;
  });
  closeDocument();
});

const linesSaying = (text: string): string[] =>
  consoleLines.filter((line) => line.includes(text));

beforeEach(() => {
  consoleLines.length = 0;
  publisher = PUBLISHER;
});

test('nothing is requested while the visitor has not answered the prompt', () => {
  const { scripts } = loadPage();
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.adsMode(), 'none', 'an unanswered prompt is not a decline');
  assert.deepEqual(scripts, []);
});

test('a record written before the ads category existed loads nothing', () => {
  // It re-prompts (the policy version moved), so it is not an ads decision - and
  // an undecided visitor gets no partner script.
  const { scripts } = loadPage(legacyStored('granted'));
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.isAdsGranted(), false);
  assert.deepEqual(scripts, []);
});

test('an ads opt-in loads the partner', () => {
  const { scripts } = loadPage(stored(uniformGrants('granted')));
  assert.equal(ads.loadAds(), true);
  assert.equal(ads.isAdsGranted(), true);

  const [script, ...rest] = partnerScripts(scripts);
  assert.deepEqual(rest, [], 'exactly one partner script');
  assert.equal(script.async, true);
  assert.equal(script.crossOrigin, 'anonymous');
  assert.equal(
    new URL(script.src ?? '').searchParams.get('client'),
    PUBLISHER,
    'the loader reads the publisher id off its own query string',
  );
  assert.equal(ads.adsMode(), 'personalised');
  assert.equal(script.npaWhenInjected, undefined, 'personalisation is left on for a grant');
});

test('every unit on the page may ask, and the partner still loads once', () => {
  const { scripts } = loadPage(stored(uniformGrants('granted')));
  // Four placements, four calls, one document.
  const loaded = [ads.loadAds(), ads.loadAds(), ads.loadAds(), ads.loadAds()];
  assert.deepEqual(loaded, [true, true, true, true]);
  assert.equal(partnerScripts(scripts).length, 1);
});

test('a decline falls back to non-personalised ads', () => {
  // "No" to advertising is not "no ads": the partner still loads, with
  // personalisation switched off for the whole page, so the visitor sees
  // contextual units and nothing is used to profile them.
  const { scripts, window } = loadPage(stored({ analytics: 'granted', ads: 'denied' }));
  assert.equal(ads.loadAds(), true);
  assert.equal(ads.isAdsGranted(), false, 'a decline is not an opt-in');
  assert.equal(ads.adsMode(), 'non-personalised');

  const [script, ...rest] = partnerScripts(scripts);
  assert.deepEqual(rest, [], 'exactly one partner script');
  assert.equal(window.adsbygoogle?.requestNonPersonalizedAds, 1);
  assert.equal(script.npaWhenInjected, 1, 'set before the tag could drain its queue');
});

test('a mid-page opt-in loads personalised, and a mid-page withdrawal does not', () => {
  // The preferences dialog is reachable from the footer on every page, so the
  // stored record can change under a document that has already asked for ads.
  const { scripts, window } = loadPage();
  assert.equal(ads.loadAds(), false, 'nothing loads while the prompt is unanswered');

  localStorage.setItem(CONSENT_KEY, stored(uniformGrants('granted')));
  assert.equal(ads.isAdsGranted(), true, 'the new decision is readable straight away');
  assert.equal(ads.loadAds(), true, 'and the opt-in is what finally loads the partner');
  assert.equal(scripts[0].npaWhenInjected, undefined, 'personalised, as granted');

  // Withdrawing cannot unsend the script this document already has, but it does
  // withdraw permission to personalise: every unit built from here on is
  // contextual, and the page-wide flag is left standing for whatever reads it.
  localStorage.setItem(CONSENT_KEY, stored({ analytics: 'granted', ads: 'denied' }));
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.loadAds(), true);
  assert.equal(ads.adsMode(), 'non-personalised');
  assert.equal(window.adsbygoogle?.requestNonPersonalizedAds, 1);
  assert.equal(partnerScripts(scripts).length, 1, 'and no second script is added');
});

test('a privacy signal blocks ads outright, over a stored grant', () => {
  // A browser-level opt-out is not a preference about personalisation: it takes
  // the whole category, so it gets no partner at all rather than the contextual
  // ads a visitor who declined in the dialog would see.
  const { scripts, window } = loadPage(stored(uniformGrants('granted')), { doNotTrack: '1' });
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.adsMode(), 'none');
  assert.deepEqual(scripts, []);
  assert.equal(window.adsbygoogle, undefined, 'not even the queue is created');
});

test('a privacy signal blocks ads outright, over a stored decline', () => {
  const { scripts, window } = loadPage(stored({ analytics: 'denied', ads: 'denied' }), {
    doNotTrack: '1',
  });
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.adsMode(), 'none');
  assert.deepEqual(scripts, []);
  assert.equal(window.adsbygoogle, undefined, 'not even the queue is created');
});

test('an unconfigured build disables ads silently after a single warning', () => {
  publisher = '';
  const { scripts, window } = loadPage(stored(uniformGrants('granted')));
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.loadAds(), false);
  assert.deepEqual(scripts, []);
  assert.equal(window.adsbygoogle, undefined, 'no queue either, personalised or not');
  assert.equal(linesSaying('[ads]').length, 1, 'one warning per document, not one per unit');
  assert.match(consoleLines[0], /PUBLIC_ADSENSE_CLIENT/);
});

test('an unconfigured build disables the non-personalised path too', () => {
  publisher = '';
  const { scripts, window } = loadPage(stored({ analytics: 'granted', ads: 'denied' }));
  assert.equal(ads.adsMode(), 'non-personalised', 'the decision is still readable');
  assert.equal(ads.loadAds(), false, 'but there is no publisher to serve against');
  assert.deepEqual(scripts, []);
  assert.equal(window.adsbygoogle, undefined);
  assert.equal(linesSaying('[ads]').length, 1);
});

test('the static build, which has no document, loads nothing and throws nothing', () => {
  closeDocument();
  assert.equal(ads.loadAds(), false);
  assert.equal(ads.isAdsGranted(), false);
  assert.equal(ads.adsMode(), 'none');
});
