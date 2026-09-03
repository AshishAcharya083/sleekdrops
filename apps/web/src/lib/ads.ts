/**
 * Ads - the consent gate in front of the ad partner, and the only place the
 * partner is named.
 *
 * A page component asks for ads by calling `loadAds()`; it never learns which
 * network answers. That is deliberate: the placements are the product decision
 * and the network is not, so moving off AdSense later touches this module and
 * `./ads-env` rather than every page that carries a unit.
 *
 * The gate is opt-in and nothing else. The partner script is fetched only for a
 * visitor who has switched the advertising category on in the consent dialog:
 *
 *  - **granted** - the partner script loads and serves ads.
 *  - **anything else** - nothing is fetched, injected or evaluated. A decline, a
 *    GPC/DNT signal and an unanswered prompt are all treated the same way,
 *    because the partner tag reads and writes device storage of its own the
 *    moment it runs (frequency capping, invalid-traffic checks) whatever the
 *    personalisation flags say. Serving contextual ads to a visitor who declined
 *    would place that storage without consent, so a decline means no ad partner
 *    at all rather than a quieter one.
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

/** What this document has already done: loaded the partner, and complained. */
interface AdsState {
  loaded: boolean;
  warned: boolean;
}

interface AdsHost {
  __sdAds?: AdsState;
}

declare global {
  interface Window {
    __sdAds?: AdsState;
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
 * True when the visitor has explicitly opted in to advertising. A GPC/DNT signal
 * resolves the whole category to a denial, so it is answered here too.
 */
export function isAdsGranted(): boolean {
  return resolveConsent(readConsent(), hasPrivacySignal()).effects.ads === 'grant';
}

/** One `[ads]` warning per document, however many units asked for one. */
function warnOnce(message: string): void {
  const state = adsState();
  if (state.warned) return;
  state.warned = true;
  console.warn('[ads] ' + message);
}

/**
 * Load the ad partner for this document, if the visitor has opted in to ads.
 *
 * Returns true when this caller may show a unit: the partner is on the page and
 * the opt-in behind it still stands. Safe to call from every unit on the page -
 * the script is injected at most once per document, so the second and every
 * later caller gets true without a second request.
 *
 * False means show nothing: no opt-in on file, an unconfigured build, or no DOM
 * at all (the static build). A withdrawal made from the footer mid-page reads as
 * false from that moment on - the script already sent cannot be unsent, but no
 * further unit is rendered against it.
 */
export function loadAds(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!isAdsGranted()) return false;

  const { client } = adsEnv();
  if (!client) {
    warnOnce(
      'ad partner NOT configured - PUBLIC_ADSENSE_CLIENT is empty or is not a ca-pub-<digits> publisher id',
    );
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
  console.info(`[ads] partner loaded -> ${client}`);
  return true;
}
