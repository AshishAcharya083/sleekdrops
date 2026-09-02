/**
 * The ad loader, driven the way a page component drives it: a real document with
 * a real stored consent record, and the shipped `./ads` module deciding what -
 * if anything - to put on the page.
 *
 * Everything here asserts against the DOM the module actually produced rather
 * than against an interface of its own, because the two things that matter are
 * both observable only there: that no partner script is requested before the
 * visitor has agreed to one, and that the non-personalised flag is in place
 * *before* the loader it applies to is appended.
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

/** A `<script>` as the module built it, with the attributes it chose to set. */
interface FakeScript {
  src?: string;
  async?: boolean;
  crossOrigin?: string;
  attributes: Record<string, string>;
  /**
   * The partner's non-personalised flag as it stood the instant this script was
   * appended - which is the only moment that matters, because appending is what
   * starts the request that reads it.
   */
  npaFlagOnAppend?: number;
}

interface FakeWindow {
  localStorage: unknown;
  doNotTrack?: string;
  adsbygoogle?: { requestNonPersonalizedAds?: number };
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
    createElement: (): FakeScript => ({
      attributes: {},
      setAttribute(this: FakeScript, name: string, value: string): void {
        this.attributes[name] = value;
      },
    }),
    head: {
      appendChild: (node: FakeScript): void => {
        node.npaFlagOnAppend = window.adsbygoogle?.requestNonPersonalizedAds;
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
  assert.equal(ads.loadAds(), null);
  assert.equal(ads.isAdsGranted(), false);
  assert.deepEqual(scripts, []);
});

test('a record written before the ads category existed loads nothing', () => {
  // It re-prompts (the policy version moved), so it is not an ads decision - and
  // an undecided visitor gets no partner script.
  const { scripts } = loadPage(legacyStored('granted'));
  assert.equal(ads.loadAds(), null);
  assert.equal(ads.isAdsGranted(), false);
  assert.deepEqual(scripts, []);
});

test('an ads grant loads the partner for personalised serving', () => {
  const { scripts, window } = loadPage(stored(uniformGrants('granted')));
  assert.equal(ads.loadAds(), 'personalized');
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
  assert.equal(script.attributes['data-npa'], undefined);
  assert.equal(script.npaFlagOnAppend, undefined, 'a grant is never downgraded to contextual');
  assert.equal(window.adsbygoogle?.requestNonPersonalizedAds, undefined);
});

test('every unit on the page may ask, and the partner still loads once', () => {
  const { scripts } = loadPage(stored(uniformGrants('granted')));
  // Four placements, four calls, one document.
  const modes = [ads.loadAds(), ads.loadAds(), ads.loadAds(), ads.loadAds()];
  assert.deepEqual(modes, ['personalized', 'personalized', 'personalized', 'personalized']);
  assert.equal(partnerScripts(scripts).length, 1);
});

test('a decline serves non-personalised ads, flagged before the loader is appended', () => {
  const { scripts } = loadPage(stored({ analytics: 'granted', ads: 'denied' }));
  assert.equal(ads.loadAds(), 'non-personalized');
  assert.equal(ads.isAdsGranted(), false);

  const [script] = partnerScripts(scripts);
  assert.ok(script, 'a declined visitor still sees contextual ads');
  assert.equal(script.attributes['data-npa'], '1');
  assert.equal(
    script.npaFlagOnAppend,
    1,
    'the flag must be on the queue before the loader that reads it is appended',
  );
});

test('a mid-page consent change reports the mode actually in force', () => {
  // The preferences dialog is reachable from the footer on every page, so the
  // stored record can change under a document that has already loaded the
  // partner. The script cannot be re-fetched in another mode, so saying so is the
  // only honest answer - a unit that believed the upgrade would render a
  // personalised slot against a non-personalised loader.
  const { scripts } = loadPage(stored({ analytics: 'granted', ads: 'denied' }));
  assert.equal(ads.loadAds(), 'non-personalized');

  localStorage.setItem(CONSENT_KEY, stored(uniformGrants('granted')));
  assert.equal(ads.isAdsGranted(), true, 'the new decision is readable straight away');
  assert.equal(ads.loadAds(), 'non-personalized', 'but this document is already loaded');
  assert.equal(partnerScripts(scripts).length, 1);
});

test('a privacy signal blocks ads outright, over a stored grant', () => {
  const { scripts, window } = loadPage(stored(uniformGrants('granted')), { doNotTrack: '1' });
  assert.equal(ads.loadAds(), null);
  assert.equal(ads.isAdsGranted(), false);
  assert.deepEqual(scripts, []);
  assert.equal(window.adsbygoogle, undefined, 'not even the queue is created');
});

test('an unconfigured build disables ads silently after a single warning', () => {
  publisher = '';
  const { scripts } = loadPage(stored(uniformGrants('granted')));
  assert.equal(ads.loadAds(), null);
  assert.equal(ads.loadAds(), null);
  assert.deepEqual(scripts, []);
  assert.equal(linesSaying('[ads]').length, 1, 'one warning per document, not one per unit');
  assert.match(consoleLines[0], /PUBLIC_ADSENSE_CLIENT/);
});

test('the static build, which has no document, loads nothing and throws nothing', () => {
  closeDocument();
  assert.equal(ads.loadAds(), null);
  assert.equal(ads.isAdsGranted(), false);
});
