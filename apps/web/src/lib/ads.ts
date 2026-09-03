/**
 * Ads - the consent gate in front of the ad partner, and the only place the
 * partner is named.
 *
 * A page component asks for ads by calling `loadAds()`; it never learns which
 * network answers. That is deliberate: the placements are the product decision
 * and the network is not, so moving off AdSense later touches this module and
 * `./ads-env` rather than every page that carries a unit.
 *
 * The partner script is requested for one state and one only: an explicit
 * advertising opt-in. Everything else - a decline, an unanswered prompt, a
 * GPC/DNT signal - leaves it unrequested, because the tag writes cookies and
 * device storage for itself (frequency capping, reporting, fraud) the moment it
 * runs, and ePrivacy Art. 5(3) conditions that storage on consent whether or not
 * the ads are personalised.
 *
 * Non-personalised serving is therefore a *mode*, not a second loading path: a
 * decline sets `requestNonPersonalizedAds` on the partner's queue, so that if a
 * document ever does hold the tag - the visitor opted in earlier on this page and
 * withdrew since - nothing it serves from then on is personalised. What it never
 * does is fetch the tag on the strength of a "no".
 *
 * Google's Consent Mode v2 is deliberately not used to soften that: its signals
 * only take effect once a Google tag library drains the queue they are pushed
 * onto, this site loads no such library except behind the analytics grant, and a
 * denial that may never be applied is not a gate.
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
 * What the visitor's decision allows on this page:
 *  - `personalised`     - ads, targeted, on an explicit advertising opt-in
 *  - `non-personalised` - a decline: nothing may be fetched for it, and anything
 *                         already fetched serves contextually from here on
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
 * than from the visitor is a blanket opt-out of the category, and this module
 * touches nothing at all for it - not even the partner's queue.
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
 * Load the ad partner for this document, if the visitor's decision allows it at
 * all.
 *
 * Returns true when this caller may show a unit: the visitor opted in to
 * advertising, the build has a publisher id, and the partner is on the page. Safe
 * to call from every unit on the page - the script is injected at most once per
 * document, so the second and every later caller gets true without a second
 * request.
 *
 * False means show nothing, and covers every state that is not an opt-in: a
 * decline, an unanswered prompt, a GPC/DNT signal, an unconfigured build, or no
 * DOM at all (the static build). A withdrawal made from the footer mid-page
 * cannot unsend the script this document already has, nor un-render a unit
 * already on screen, but it does switch this off for every unit built after it -
 * and switches personalisation off for the tag already running.
 */
export function loadAds(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  const mode = adsMode();
  if (mode === 'none') return false;

  const { client } = adsEnv();
  if (!client) {
    warnOnce(
      'ad partner NOT configured - PUBLIC_ADSENSE_CLIENT is empty or is not a ca-pub-<digits> publisher id',
    );
    return false;
  }

  // A decline is where the loading stops. The flag is still set, because a
  // document that already loaded the tag under an earlier opt-in keeps it, and
  // from here on it must serve contextually - but no "no" ever fetches the tag.
  if (mode === 'non-personalised') {
    requestNonPersonalizedAds();
    return false;
  }

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
