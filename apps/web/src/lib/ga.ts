/**
 * Google Analytics 4 - the second analytics sink, and the only module in the
 * site that touches gtag.js (mirroring the chokepoint discipline `./analytics`
 * applies to the DevTeam SDK, `./experiments` to GrowthBook and `./ads` to the
 * ad partner).
 *
 * It is reached from exactly two places in `./analytics`: the consent-grant and
 * consent-withdrawal paths call `startGa` / `stopGa`, and the one `send()`
 * chokepoint every outgoing event already passes through calls `sendGa` with the
 * payload the PII scrub has already returned. Nothing here re-derives a payload,
 * re-reads consent or re-stamps an event - one scrub, one theme/visit/experiment
 * stamp, two sinks.
 *
 * Four properties this module has to guarantee:
 *
 *  1. **Consent first, and only for as long as it lasts.** gtag.js is not
 *     requested until `startGa` is called, and `./analytics` calls it only from
 *     the grant path. `stopGa` is the other half, and it cannot merely stop
 *     calling the tag: the script stays in the DOM and goes on emitting on its
 *     own (a `user_engagement` on every visibility change and unload, plus
 *     whatever enhanced measurement the property has switched on), so the
 *     per-property opt-out flag is the only thing that stops it, and its
 *     identifier cookies have to be expired behind it.
 *  2. **The property is configuration, never a constant.** The measurement id
 *     comes from `./ga-env`, so develop and production report into whichever
 *     properties their builds were given and a local `pnpm dev` - which has
 *     none - reports into nothing at all. An empty or wrong-shaped id disables
 *     the sink after one warning rather than tagging the document with a
 *     property that cannot receive it.
 *  3. **No page identity Google was not meant to see.** GA4 would otherwise
 *     auto-capture `location.href` and `document.referrer` verbatim, raw query
 *     strings included. Both are overridden at `config` time with the same
 *     normalized, path-only reduction the `Page Viewed` event carries, and
 *     because `config` parameters apply to every later event from the tag, the
 *     override holds for the whole document rather than for the first hit.
 *  4. **GA4's own naming rules, enforced here rather than assumed.** The site's
 *     taxonomy is Title Case with a `$`-prefixed platform namespace; GA4 accepts
 *     neither, and silently discards an event or a parameter it cannot name. The
 *     mapping below is pure and unit-tested, and an event it cannot name is
 *     dropped with a warning instead of being sent into a black hole.
 *
 * All console lines are prefixed `[analytics]` through the injected logger, so
 * GA4 activity filters alongside the rest of the telemetry.
 */

// Explicit .ts extensions: this module is loaded directly by the node --test
// runner (see ga.test.ts), which needs real specifiers.
import { gaEnv } from './ga-env.ts';
import { urlToPath, type EventProps } from './pii.ts';
import { normalizePath } from './visit.ts';

/** Console + platform logging, injected so this module stays sink-agnostic. */
export type GaLog = (level: 'info' | 'warn', message: string) => void;

/** The gtag.js surface this module uses, as it exists on the document. */
interface TagWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

const tagWindow = (): (Window & TagWindow) | null =>
  typeof window === 'undefined' ? null : (window as Window & TagWindow);

/** This build's measurement id, or `''` when GA4 is not configured. */
export const gaId = (): string => gaEnv().id;

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The events whose GA4 name is a contract rather than a transliteration.
 *
 * `Page Viewed` is GA4's own `page_view`: it is the event every standard report,
 * every Realtime card and every engagement metric in the product is built on, so
 * the site's page view has to arrive *as* that event rather than beside it. The
 * tag is configured with `send_page_view: false` precisely so this one is the
 * only page view GA4 sees - see `startGa`.
 *
 * The two `$`-prefixed platform events lose the prefix, which GA4 does not
 * accept in a name. They are the only names in the taxonomy that carry it, and
 * they are listed rather than stripped by rule so that a future platform event
 * has to be named here consciously.
 */
const GA_EVENT_NAMES: Readonly<Record<string, string>> = {
  'Page Viewed': 'page_view',
  $experiment_viewed: 'experiment_viewed',
  $client_error: 'client_error',
};

/**
 * Names GA4 reserves for itself. Sending one is not an error the browser
 * surfaces - the hit is accepted and discarded - so an event that collided with
 * one would read as an event nobody ever fired.
 *
 * `error`, `session_start` and `user_engagement` are the three the site could
 * plausibly walk into: a `$client_error` transliterated by rule would land on
 * the first, and the SDK-shaped `$session_start` on the second. Both are avoided
 * by the map above, and this set is what keeps them avoided if either is ever
 * renamed.
 */
const GA_RESERVED_EVENTS: ReadonlySet<string> = new Set([
  'ad_activeview',
  'ad_click',
  'ad_exposure',
  'ad_query',
  'ad_reward',
  'adunit_exposure',
  'app_clear_data',
  'app_exception',
  'app_remove',
  'app_store_refund',
  'app_store_subscription_cancel',
  'app_store_subscription_convert',
  'app_store_subscription_renew',
  'app_update',
  'dynamic_link_app_open',
  'dynamic_link_app_update',
  'dynamic_link_first_open',
  'error',
  'first_open',
  'first_visit',
  'in_app_purchase',
  'notification_dismiss',
  'notification_foreground',
  'notification_open',
  'notification_receive',
  'os_update',
  'session_start',
  'user_engagement',
]);

/** Prefixes GA4 reserves for itself, on both event and parameter names. */
const GA_RESERVED_PREFIXES = ['ga_', 'google_', 'firebase_'] as const;

/**
 * GA4's shape rule for an event or parameter name: it starts with a letter, is
 * letters, digits and underscores throughout, and is at most 40 characters.
 */
const GA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** GA4 truncates a parameter value past this many characters. */
const GA_VALUE_MAX_LENGTH = 100;

/**
 * GA4 keeps at most this many parameters on an event and drops the rest, so the
 * cap is applied here, where the order is known, rather than left to Google.
 *
 * `./analytics` builds its payload with the site's own structural properties
 * first and the sticky `$exp_*` stamps last, and a visitor can hold up to 32 of
 * those stamps at once (`MAX_STICKY_PROPS` in `./experiments`) - so taking the
 * first 25 drops surplus experiment stamps and never a dimension the funnel is
 * measured on.
 */
const GA_MAX_PARAMS = 25;

const isReserved = (name: string): boolean =>
  GA_RESERVED_EVENTS.has(name) || GA_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * The site's Title Case event name as GA4 spells it: lowercase words joined by
 * underscores, with every run of non-alphanumeric characters collapsing into one
 * separator (`TOC Link Clicked` -> `toc_link_clicked`).
 *
 * Mechanical rather than a second hand-maintained map, so a taxonomy event added
 * to `EVENTS` reaches GA4 without a second edit that could be forgotten - which
 * is the failure this whole integration exists to remove. `ga.test.ts` asserts
 * the derivation over the real `EVENTS` map, so a name the rule cannot handle
 * fails the build instead of going missing from one sink.
 */
export function snakeCase(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * The GA4 name for one taxonomy event, or `null` when GA4 could not accept it.
 *
 * `null` is a real outcome rather than a defensive branch: it is what stops a
 * name GA4 would silently discard from being sent as though it had been counted,
 * and `sendGa` turns it into one warning naming the event.
 */
export function gaEventName(event: string): string | null {
  const mapped = GA_EVENT_NAMES[event] ?? snakeCase(event);
  if (!GA_NAME_PATTERN.test(mapped) || isReserved(mapped)) return null;
  return mapped;
}

/**
 * One scrubbed property name as GA4 spells it, or `null` when GA4 could not
 * accept it.
 *
 * The single transformation is dropping a leading `$`: the sticky experiment
 * stamps (`$exp_<key>`) are the only properties on the wire that carry one, and
 * GA4 rejects the character outright, so without this every experiment would be
 * measurable in DevTeam and invisible in GA4. `./pii` has already narrowed both
 * halves of a stamp to a structural shape, so the value needs no further check
 * here beyond the length GA4 imposes on every parameter.
 */
export function gaParamName(key: string): string | null {
  const name = key.startsWith('$') ? key.slice(1) : key;
  if (!GA_NAME_PATTERN.test(name) || isReserved(name)) return null;
  return name;
}

/**
 * An already-scrubbed event payload as GA4's parameter rules require it: names
 * GA4 accepts, values inside its length limit, and at most `GA_MAX_PARAMS` of
 * them.
 *
 * This runs *after* `scrub()` and never instead of it. The scrub is what decides
 * whether a property may leave the browser at all; this only decides how GA4
 * spells what the scrub already released, so a property dropped there can never
 * reappear here.
 */
export function gaEventParams(props?: EventProps | null): EventProps {
  const out: EventProps = {};
  if (!props) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(props)) {
    if (kept >= GA_MAX_PARAMS) break;
    const name = gaParamName(key);
    if (name === null) continue;
    if (typeof value === 'string') out[name] = value.slice(0, GA_VALUE_MAX_LENGTH);
    else if (typeof value === 'number') out[name] = value;
    // GA4 stores a parameter as a string or a number, so a boolean is spelled
    // rather than left to the tag's own coercion.
    else if (typeof value === 'boolean') out[name] = String(value);
    else continue;
    kept++;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The tag                                                                    */
/* -------------------------------------------------------------------------- */

/** gtag.js's documented per-property kill switch: set truthy and the tag sends nothing. */
const disableFlag = (id: string): string => `ga-disable-${id}`;

/** GA4's identifier cookies - `_ga` and the per-property `_ga_<container>`. */
const GA_COOKIE = /^_ga(_|$)/;

/**
 * Turn the GA4 tag off - or, on a re-grant, back on - for the rest of this
 * document.
 *
 * Setting it back to false matters just as much as setting it: `startGa` is a
 * no-op once the tag is loaded, so a visitor who withdraws and opts back in on
 * the same page would otherwise stay silently opted out of the sink they just
 * re-consented to.
 */
export function setGaOptOut(disabled: boolean): void {
  const w = tagWindow();
  const id = gaId();
  if (!w || !id) return;
  (w as unknown as Record<string, boolean>)[disableFlag(id)] = disabled;
}

/**
 * Expire GA4's identifier cookies. gtag.js writes them with `path=/` on the
 * registrable domain, which is not necessarily the host this page is served
 * from, and a cookie is only removed by a write matching the pair it was set
 * with - so every domain this host could have used is tried. A write for a
 * domain the page is not allowed to set is dropped by the browser.
 */
export function forgetGaCookies(): void {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return;
  const names = document.cookie
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter((name) => GA_COOKIE.test(name));
  if (names.length === 0) return;
  const labels = (typeof location === 'undefined' ? '' : location.hostname).split('.');
  // Every parent domain down to - but not including - the public suffix, which no
  // site is allowed to write, plus the host itself (no domain attribute at all).
  const parents = labels
    .slice(0, -1)
    .map((_, index) => `; domain=.${labels.slice(index).join('.')}`);
  names.forEach((name) => {
    ['', ...parents].forEach((domain) => {
      document.cookie = `${name}=; path=/; max-age=0${domain}`;
    });
  });
}

/** Stop the GA4 sink and take its identifier cookies with it. */
export function stopGa(): void {
  setGaOptOut(true);
  forgetGaCookies();
}

/**
 * Load and configure gtag.js for this build's property. Returns whether the tag
 * was requested, so the caller can hold its one-per-document guard.
 *
 * Callers must have the analytics category granted: this requests a third-party
 * script that writes identifier cookies as soon as it runs.
 */
export function startGa(log: GaLog): boolean {
  const w = tagWindow();
  const id = gaId();
  if (!w || typeof document === 'undefined') return false;
  if (!id) {
    log('warn', 'GA4 NOT configured - PUBLIC_GA4_ID is empty or not a G- measurement id');
    return false;
  }
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(tag);
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag(): void {
    w.dataLayer!.push(arguments);
  };
  w.gtag('js', new Date());
  w.gtag('config', id, {
    // The site dispatches its own page view - once per document per path, with
    // the screen, category, slug and brand the taxonomy gives it - and it arrives
    // here as GA4's `page_view`. Letting `config` send one too would report the
    // same view twice: once bare, once with its dimensions.
    send_page_view: false,
    // Override the page params GA4 would otherwise auto-capture, so raw query
    // strings (which can carry PII) never reach Google - path only. `config`
    // parameters apply to every later event from this tag, so the override holds
    // for the whole document rather than only for the first hit. The page
    // identity is normalized exactly as the `Page Viewed` event's `path` is, so a
    // slash-suffixed entry URL does not split GA4's page count either; the
    // referrer gets the same plain reduction as the event's, so the two sinks
    // agree.
    page_location: location.origin + normalizePath(location.href),
    page_referrer: urlToPath(document.referrer),
  });
  log('info', 'GA4 initialized -> ' + id);
  return true;
}

/**
 * Forward one already-scrubbed event to GA4.
 *
 * Silent when GA4 is not configured or the tag has not been loaded, so the
 * caller needs no guard of its own; that also means an environment without a
 * measurement id costs the send path nothing.
 */
export function sendGa(event: string, props: EventProps, log: GaLog): void {
  const w = tagWindow();
  const id = gaId();
  if (!w || !id || typeof w.gtag !== 'function') return;
  const name = gaEventName(event);
  if (name === null) {
    log('warn', `GA4 cannot name the event '${event}' - not forwarded`);
    return;
  }
  // `send_to` names the property explicitly rather than relying on the tag being
  // the only one configured on the document, and gtag strips it from the payload.
  w.gtag('event', name, { ...gaEventParams(props), send_to: id });
}
