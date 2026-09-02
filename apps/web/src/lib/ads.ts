/**
 * Ads - the consent gate in front of the ad partner, and the only place the
 * partner is named.
 *
 * A page component asks for ads by calling `loadAds()`; it never learns which
 * network answers. That is deliberate: the placements are the product decision
 * and the network is not, so moving off AdSense later touches this module and
 * `./ads-env` rather than every page that carries a unit.
 *
 * Nothing is fetched, injected or evaluated before the visitor has answered the
 * consent prompt. What happens after depends on the answer:
 *
 *  - **granted** - the partner script loads and serves personalised ads.
 *  - **declined** - the script still loads, but with the partner's
 *    non-personalised flag set first, so the visitor sees contextual ads and no
 *    profile is built from them. This is the fallback the ad units are scoped
 *    around; it is not consent-by-another-name, because the personalisation the
 *    visitor refused is exactly what the flag turns off.
 *  - **a GPC/DNT signal** - nothing loads at all. A browser-level opt-out is a
 *    blanket refusal rather than a preference about personalisation, so it is
 *    honoured as a refusal of the whole category, matching how `./analytics`
 *    treats the same signal.
 *  - **undecided** - nothing loads; the prompt is still on screen and the answer
 *    applies from the next call (page components call this on load).
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

/** How ads may be served once the script is on the page. */
export type AdsMode = 'personalized' | 'non-personalized';

/** What the visitor's stored decision means for ads on this page load. */
type AdsDecision = AdsMode | 'blocked' | 'pending';

/**
 * The partner's queue object. It exists before the script does - the loader picks
 * up whatever was pushed onto it - which is what makes the non-personalised flag
 * settable ahead of the network request rather than after it.
 */
interface AdsByGoogle extends Array<unknown> {
  requestNonPersonalizedAds?: number;
}

/** What this document has already done: loaded the partner, and complained. */
interface AdsState {
  /** The mode the partner was loaded in, or null while it has not been loaded. */
  mode: AdsMode | null;
  warned: boolean;
}

interface AdsHost {
  __sdAds?: AdsState;
  adsbygoogle?: AdsByGoogle;
}

declare global {
  interface Window {
    __sdAds?: AdsState;
    adsbygoogle?: AdsByGoogle;
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
  return (host.__sdAds ??= { mode: null, warned: false });
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

/** What to do about ads right now, from the stored record and the privacy signal. */
function adsDecision(): AdsDecision {
  const { prompt, effects } = resolveConsent(readConsent(), hasPrivacySignal());
  if (prompt === 'gpc') return 'blocked';
  if (effects.ads === 'pending') return 'pending';
  return effects.ads === 'grant' ? 'personalized' : 'non-personalized';
}

/** True when the visitor has explicitly opted in to personalised advertising. */
export function isAdsGranted(): boolean {
  return adsDecision() === 'personalized';
}

/** One `[ads]` warning per document, however many units asked for one. */
function warnOnce(message: string): void {
  const state = adsState();
  if (state.warned) return;
  state.warned = true;
  console.warn('[ads] ' + message);
}

/**
 * Load the ad partner for this document, if the visitor's decision allows it.
 *
 * Returns the mode ads are being served in, or null when nothing was loaded - an
 * undecided or blanket-refusing visitor, an unconfigured build, or no DOM at all
 * (the static build). Safe to call from every unit on the page: the script is
 * injected at most once per document, and the call that injects it is the one
 * that fixes the mode - every later call reports the mode actually in force
 * rather than the one it would have chosen.
 */
export function loadAds(): AdsMode | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const decision = adsDecision();
  if (decision === 'blocked' || decision === 'pending') return null;

  const { client } = adsEnv();
  if (!client) {
    warnOnce('ad partner NOT configured - PUBLIC_ADSENSE_CLIENT is empty');
    return null;
  }

  const state = adsState();
  if (state.mode) return state.mode;
  state.mode = decision;

  // Pushed onto the partner's queue before its script is requested: the flag has
  // to be in place by the time the loader evaluates, or the first impression is
  // served personalised to a visitor who declined that.
  const queue: AdsByGoogle = (window.adsbygoogle ??= [] as AdsByGoogle);
  if (decision === 'non-personalized') queue.requestNonPersonalizedAds = 1;

  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `${ADS_SCRIPT_SRC}?client=${encodeURIComponent(client)}`;
  if (decision === 'non-personalized') script.setAttribute('data-npa', '1');
  document.head.appendChild(script);
  console.info(`[ads] partner loaded (${decision}) -> ${client}`);
  return decision;
}
