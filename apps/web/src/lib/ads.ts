/**
 * Ads - the consent gate in front of the ad partner, and the only place the
 * partner is named.
 *
 * A page component asks for ads by calling `loadAds()`; it never learns which
 * network answers. That is deliberate: the placements are the product decision
 * and the network is not, so moving off AdSense later touches this module and
 * `./ads-env` rather than every page that carries a unit.
 *
 * The gate has three outcomes, one per `AdsMode`:
 *
 *  - **granted** - personalised ads. The partner script loads as it ships.
 *  - **declined** - non-personalised ads. The partner script loads with
 *    personalisation switched off for the whole page (`requestNonPersonalizedAds`,
 *    the flag the partner reads off its own queue), so the visitor sees contextual
 *    ads only and nothing is used to profile them. This is the product decision
 *    for a visitor who answered the prompt with "no": ads still pay for the site,
 *    but not with their profile.
 *  - **blocked or unanswered** - nothing is fetched, injected or evaluated. A
 *    GPC/DNT signal is a legal opt-out of the whole category rather than a
 *    preference about personalisation, and an unanswered prompt is not a decision
 *    at all, so neither may place the storage the partner tag writes for itself.
 *
 * A unit renders itself: it asks `loadAds()` whether it may, and `adsMode()` how.
 * A unit built while the mode is `non-personalised` must also carry the partner's
 * own per-slot `data-npa="1"` attribute, because the page-wide flag below is read
 * once, as the tag starts, and a decision withdrawn after that reaches only the
 * slots that still spell it out for themselves.
 *
 * The stored record is read through the same `./consent` decision table
 * `./analytics` uses, so the two categories can never drift apart, and this
 * module deliberately does not import `./analytics`: a page with an ad unit must
 * not pull the analytics SDKs into its bundle to find out whether it may show one.
 *
 * All console lines are prefixed `[ads]`, matching the `[analytics]` convention.
 */

// Explicit .ts extensions: this module is loaded directly by the node --test
// runner (see ads.test.ts), which needs real specifiers.
import { adsEnv } from './ads-env.ts';
import { CONSENT_KEY, parseConsent, resolveConsent } from './consent.ts';
import { hasPrivacySignal } from './privacy-signal.ts';

/** The partner's loader, which reads the publisher id off its own query string. */
const ADS_SCRIPT_SRC = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

/**
 * What a unit on this page may show:
 *  - `personalised`     - ads, targeted, on an explicit advertising opt-in
 *  - `non-personalised` - contextual ads only, for a visitor who declined
 *  - `none`             - no ad partner at all: blocked, or not yet answered
 */
export type AdsMode = 'personalised' | 'non-personalised' | 'none';

/** What this document has already done: loaded the partner, and complained. */
interface AdsState {
  loaded: boolean;
  warned: boolean;
}

interface AdsHost {
  __sdAds?: AdsState;
}

/**
 * The partner's own command queue. It is an array the tag drains, and the
 * personalisation flag rides on the array itself - which is why it can be set
 * before the tag has loaded, and must be.
 */
interface AdsQueue extends Array<unknown> {
  requestNonPersonalizedAds?: number;
}

declare global {
  interface Window {
    __sdAds?: AdsState;
    adsbygoogle?: AdsQueue;
  }
}

/** Stand-in host for the static build and the test runner, where there is no `window`. */
const buildHost: AdsHost = {};

/**
 * This document's ad state, hung off the document rather than held in a
 * module-local `let` for the reason set out in `./analytics-scope`: this site has
 * more than one client entry point, and a build that inlines a copy of this
 * module per entry point would otherwise inject the partner script once per copy.
 */
function adsState(): AdsState {
  const host: AdsHost = typeof window === 'undefined' ? buildHost : window;
  return (host.__sdAds ??= { loaded: false, warned: false });
}

/** The stored consent record, or null when there is none or storage is blocked. */
function readConsent() {
  try {
    return parseConsent(localStorage.getItem(CONSENT_KEY));
  } catch {
    /* storage unavailable (private mode, quota) - no decision is on file */
    return null;
  }
}

/**
 * What this visitor may be shown right now, read fresh so a decision changed
 * mid-page from the footer applies to the units that have not rendered yet.
 *
 * A privacy signal is answered before the stored record: `resolveConsent` already
 * denies every category for one, but a denial that came from the browser rather
 * than from the visitor is a blanket opt-out and must not fall through to the
 * contextual-ads path a decline gets.
 */
export function adsMode(): AdsMode {
  const privacySignal = hasPrivacySignal();
  const { effects } = resolveConsent(readConsent(), privacySignal);
  if (effects.ads === 'grant') return 'personalised';
  if (privacySignal || effects.ads === 'pending') return 'none';
  return 'non-personalised';
}

/**
 * True when the visitor has explicitly opted in to advertising - the state the
 * preferences dialog shows on its Advertising switch, and the only state that
 * gets personalised ads. A GPC/DNT signal resolves the whole category to a
 * denial, so it is answered here too.
 */
export function isAdsGranted(): boolean {
  return adsMode() === 'personalised';
}

/** One `[ads]` warning per document, however many units asked for one. */
function warnOnce(message: string): void {
  const state = adsState();
  if (state.warned) return;
  state.warned = true;
  console.warn('[ads] ' + message);
}

/**
 * Switch personalisation off for every unit on this page.
 *
 * Set on the queue before the tag is injected, because that is when the tag reads
 * it. It is only ever set, never cleared: a visitor who opts in mid-page keeps
 * contextual ads until the next page load, which loses a little revenue and
 * cannot leak a profile the other way round.
 */
function requestNonPersonalizedAds(): void {
  const queue: AdsQueue = (window.adsbygoogle ??= []);
  queue.requestNonPersonalizedAds = 1;
}

/**
 * Load the ad partner for this document, in the mode the visitor's decision
 * allows.
 *
 * Returns true when this caller may show a unit: the partner is on the page and
 * the decision behind it still stands. Safe to call from every unit on the page -
 * the script is injected at most once per document, so the second and every
 * later caller gets true without a second request. Callers that need to know
 * *which* kind of unit they may show ask `adsMode()`.
 *
 * False means show nothing: an unanswered prompt, a GPC/DNT signal, an
 * unconfigured build, or no DOM at all (the static build). A withdrawal made from
 * the footer mid-page cannot unsend the script this document already has, nor
 * un-render a unit already on screen, but `adsMode()` reads non-personalised from
 * that moment on and every unit built after it follows.
 */
export function loadAds(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  const mode = adsMode();
  if (mode === 'none') return false;

  const { client } = adsEnv();
  if (!client) {
    warnOnce('ad partner NOT configured - PUBLIC_ADSENSE_CLIENT is empty');
    return false;
  }

  // Re-applied on every call, not just the first, so a grant withdrawn mid-page
  // leaves the flag standing for anything that reads it later.
  if (mode === 'non-personalised') requestNonPersonalizedAds();

  const state = adsState();
  if (state.loaded) return true;
  state.loaded = true;

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `${ADS_SCRIPT_SRC}?client=${encodeURIComponent(client)}`;
  document.head.appendChild(script);
  console.info(`[ads] partner loaded -> ${client} (${mode})`);
  return true;
}
