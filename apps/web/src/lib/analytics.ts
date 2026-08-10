/**
 * Analytics - the single entry point for product tracking, and the wiring that
 * gates it behind the visitor's consent choice.
 *
 * Nothing reaches DevTeam analytics or GA4 until the visitor has opted in. Every
 * event is queued in an in-memory buffer while consent is unknown; on grant the
 * buffer flushes and subsequent events send live, on deny (including a GPC/DNT
 * signal) the buffer is dropped and nothing is ever sent. Every outgoing payload
 * - buffered or live - runs through the central PII scrub() first.
 *
 * The consent choice persists to localStorage under `sd-consent`, mirroring the
 * `sd-theme` handling in chrome.ts; we re-prompt only when the stored policy
 * version is older than the current one. The decision table itself lives in the
 * pure, unit-tested `./consent` module.
 *
 * A/B testing hangs off the same gate: `./experiments` is started from the grant
 * path with the DevTeam SDK's own distinct id, and the sticky `$exp_*` stamps it
 * hands back are merged into every outgoing payload at the send() / serverLog()
 * chokepoint - the SDK v0.2.0 has no global-properties API to do it for us.
 *
 * All console lines are prefixed `[analytics]` so you can filter them in the
 * browser devtools console to watch init / send / consent / error activity.
 */

import { createAnalytics, type AnalyticsClient } from '@getdevteam/analytics-web';

import {
  CONSENT_KEY,
  POLICY_VERSION,
  parseConsent,
  resolveConsent,
  type ConsentPrompt,
  type ConsentStatus,
} from './consent';
import { whenDistinctIdRestored } from './distinct-id';
import { scrub, urlToPath, CLIENT_ERROR_EVENT, type EventProps } from './pii';
import {
  ErrorDeduper,
  errorEventToProps,
  errorSignature,
  rejectionToProps,
  type ErrorProps,
} from './error-capture';
import {
  clearStickyProps,
  restoreStickyProps,
  start as startExperiments,
  stickyProps,
} from './experiments';

export type { EventProps, ConsentPrompt };

const GA4_ID = 'G-8B65NZ3BD4';

/**
 * The product event taxonomy. Every track call uses one of these names so the
 * vocabulary stays consistent between code and docs/analytics-events.md - the
 * doc is the canonical reference for properties and owning screens.
 */
export const EVENTS = {
  pageView: 'Page Viewed',
  heroCtaClick: 'Hero CTA Clicked',
  dealCardClick: 'Deal Card Clicked',
  affiliateClick: 'Affiliate Link Clicked',
  newsletterSignup: 'Newsletter Signup',
  themeToggled: 'Theme Toggled',
  shareClicked: 'Share Clicked',
  copyLinkClicked: 'Copy Link Clicked',
  lightboxOpened: 'Image Lightbox Opened',
  tocLinkClicked: 'TOC Link Clicked',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** True when `value` is one of the taxonomy names in the EVENTS map. */
export function isEventName(value: string): value is EventName {
  return (Object.values(EVENTS) as string[]).includes(value);
}

/**
 * Platform event marking that a visitor was bucketed into an experiment. It is
 * how the A/B Testing tab measures a result, so its name and its
 * `experiment_key` / `variant_key` properties are a contract with the platform
 * rather than part of the product taxonomy above.
 */
export const EXPERIMENT_VIEWED_EVENT = '$experiment_viewed';

/**
 * Every name track() will accept: the product taxonomy plus the two platform
 * events, which are named contracts with the analytics platform rather than
 * taxonomy entries. Narrowing the parameter to this union is what makes an
 * undeclared event name a compile error instead of a silent funnel split; the
 * one name that arrives as a runtime string (a `data-track` attribute) is
 * checked against the EVENTS values by the dispatcher in chrome.ts.
 */
export type TrackableEvent =
  | EventName
  | typeof EXPERIMENT_VIEWED_EVENT
  | typeof CLIENT_ERROR_EVENT;

// DevTeam Analytics ingest key (dtp_...) and host. Host defaults to the local
// analytics platform; set PUBLIC_DEVTEAM_ANALYTICS_HOST to https://ingest.getdevteam.ai in prod.
// An empty key disables the DevTeam sink silently.
const devteamKey = import.meta.env.PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY;
const devteamHost = import.meta.env.PUBLIC_DEVTEAM_ANALYTICS_HOST ?? 'http://localhost:6080';

type Decision = ConsentStatus | 'unknown';

interface QueuedEvent {
  event: TrackableEvent;
  props?: EventProps;
}

let decision: Decision = 'unknown';
let gaReady = false;
let devteam: AnalyticsClient | null = null;
let buffer: QueuedEvent[] = [];

/** True when the browser is signalling Global Privacy Control or Do-Not-Track. */
export function hasPrivacySignal(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  const dnt =
    nav.doNotTrack ??
    (typeof window !== 'undefined'
      ? (window as Window & { doNotTrack?: string }).doNotTrack
      : undefined);
  return dnt === '1' || dnt === 'yes';
}

function readConsent() {
  try {
    return parseConsent(localStorage.getItem(CONSENT_KEY));
  } catch {
    return null;
  }
}

function writeConsent(status: ConsentStatus): void {
  try {
    const record = { v: POLICY_VERSION, status, ts: Date.now() };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable (private mode, quota) - consent holds for the session */
  }
}

function ensureGa(): void {
  if (gaReady || typeof document === 'undefined') return;
  gaReady = true;
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`;
  document.head.appendChild(tag);
  const w = window as Window & { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void };
  w.dataLayer = w.dataLayer || [];
  w.gtag = function gtag(): void {
    w.dataLayer!.push(arguments);
  };
  w.gtag('js', new Date());
  // Override the page params GA4 would otherwise auto-capture so raw query
  // strings (which can carry PII) never reach Google - path only.
  w.gtag('config', GA4_ID, {
    page_location: location.origin + urlToPath(location.href),
    page_referrer: document.referrer ? urlToPath(document.referrer) : '',
  });
  serverLog('info', 'GA4 initialized -> ' + GA4_ID);
}

function ensureDevteam(): void {
  if (devteam) return;
  if (!devteamKey) {
    serverLog('warn', 'DevTeam analytics NOT configured - PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY is empty');
    return;
  }
  devteam = createAnalytics({
    key: devteamKey,
    host: devteamHost,
    // Page views are emitted explicitly (EVENTS.pageView), so the SDK's own
    // auto-pageview stays off to avoid double-counting.
    trackPageviews: false,
    // Uncaught errors already route through track() as a $client_error event, so
    // the SDK's built-in error capture stays off to avoid duplicate reports.
    autoCaptureErrors: false,
    onError: (error) => console.error('[analytics] DevTeam SDK error:', error),
  });
  serverLog('info', 'DevTeam analytics initialized -> ' + devteamHost);
}

/**
 * The visitor's current theme as a state property, stamped onto every outgoing
 * event and log. It is read from the `data-theme` attribute that the boot script
 * in SEOHead and toggleTheme in chrome.ts already maintain, so there is no
 * second source of truth and no new storage key; no attribute means the light
 * default.
 *
 * Stamping it here is what makes theme a population share rather than only a
 * switch rate: the 'Theme Toggled' event alone can never say what proportion of
 * visitors read the site in dark mode, because the majority - everyone sitting
 * on their stored or default preference - never touch the toggle.
 */
function themeStamp(): EventProps {
  if (typeof document === 'undefined') return {};
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  return { theme };
}

function send(item: QueuedEvent): void {
  if (!devteam) return;
  // The theme stamp goes in first, so the one call site that carries a more
  // precise per-event value ('Theme Toggled', which records the mode switched
  // to) keeps it; the two agree by construction anyway, since toggleTheme sets
  // the attribute before it tracks. Experiment stamps go in last so a call site
  // can never shadow them.
  const props = scrub({ ...themeStamp(), ...item.props, ...stickyProps() }, item.event);
  devteam.track(item.event, props);
  console.info('[analytics] event sent:', item.event, props);
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log to the browser console (prefixed [analytics]) and, once the DevTeam client
 * exists, forward the same line to the analytics platform as a server-side log so
 * it lands in the platform's Logs view. Consent-gated: the client is only created
 * after the visitor opts in, so nothing reaches the server before consent. Exported
 * so any script can emit a server-visible log.
 *
 * Carries the sticky experiment stamps and the theme state stamp, so a log line
 * written after a variant is assigned is attributable to it just like an event
 * is, and every line can be broken down by theme.
 */
export function serverLog(level: LogLevel, message: string, attributes?: EventProps): void {
  (level === 'debug' ? console.debug : console[level])('[analytics] ' + message, attributes ?? '');
  const attrs = { ...themeStamp(), ...attributes, ...stickyProps() };
  devteam?.log[level](message, Object.keys(attrs).length > 0 ? attrs : undefined);
}

/**
 * Bucket this visitor into their experiments, keyed on the very id the DevTeam
 * SDK stamps on every event it sends - exposure and conversion have to join on
 * the same key, and any other value fails silently at 0%. No client means no
 * distinct id and no way to measure a result, so experiments stay off.
 *
 * The id is taken once the SDK has restored it from storage (see
 * `./distinct-id`); reading it in the same tick the client is created would
 * bucket a returning visitor on a throwaway id.
 *
 * Called only from the grant path, so nothing is fetched, bucketed or tracked
 * before the visitor opts in.
 */
function startExperimentsForVisitor(): void {
  if (!devteam) return;
  whenDistinctIdRestored(devteam, (distinctId) => {
    if (!distinctId) return;
    startExperiments(distinctId, {
      onExposure(experimentKey, variantKey) {
        track(EXPERIMENT_VIEWED_EVENT, {
          experiment_key: experimentKey,
          variant_key: variantKey,
        });
      },
      log: serverLog,
    });
  });
}

/** Load the analytics SDKs and flush anything queued while consent was pending. */
function applyGrant(): void {
  decision = 'granted';
  // First, so every event and log this page emits - the buffered ones included -
  // is attributed to the variants this visitor was bucketed into on an earlier
  // page load.
  restoreStickyProps();
  ensureGa();
  ensureDevteam();
  serverLog('info', 'consent granted - analytics active');
  const queued = buffer;
  buffer = [];
  queued.forEach(send);
  startExperimentsForVisitor();
}

function applyDeny(): void {
  decision = 'denied';
  buffer = [];
  clearStickyProps();
  serverLog('info', 'consent denied - no events will be sent');
}

/**
 * Record an event. While consent is unknown the event is buffered in memory;
 * once granted it (and anything buffered) sends live; once denied it is
 * dropped. Callers never need to guard their tracking calls.
 *
 * `event` is the taxonomy union rather than a string: an event name that has no
 * constant in the EVENTS map cannot reach the analytics platform.
 */
export function track(event: TrackableEvent, props?: EventProps): void {
  if (decision === 'denied') return;
  if (decision === 'granted') {
    send({ event, props });
    return;
  }
  buffer.push({ event, props });
  console.debug('[analytics] event buffered (awaiting consent):', event);
}

/** Persist an explicit opt-in and start sending. */
export function grantConsent(): void {
  writeConsent('granted');
  applyGrant();
}

/** Persist an explicit opt-out and drop anything buffered. */
export function denyConsent(): void {
  writeConsent('denied');
  applyDeny();
}

/**
 * Resolve the consent state on page load and report which surface (if any) the
 * UI should show. The page-view event and any funnel events are dispatched by
 * chrome.ts through the same buffered, consent-gated track() pipeline, so they
 * flush on a silent grant and are dropped on any denial regardless of which
 * script ran first.
 */
export function boot(): ConsentPrompt {
  const { prompt, effect } = resolveConsent(readConsent(), hasPrivacySignal());
  if (effect === 'grant') applyGrant();
  else if (effect === 'deny') applyDeny();
  return prompt;
}

const deduper = new ErrorDeduper();

/**
 * Forward one shaped error payload through the consent-gated track() pipeline,
 * dropping it if an identical error was already reported inside the dedupe
 * window. Wrapped so a reporting failure can never surface to the user.
 */
function reportError(props: ErrorProps): void {
  try {
    if (!deduper.shouldReport(errorSignature(props), Date.now())) return;
    track(CLIENT_ERROR_EVENT, props);
    // Also forward to the platform's log pipeline so errors land in the Logs view,
    // not only as $client_error events. The client only exists after consent, so
    // this stays consent-gated like track().
    devteam?.log.error(String(props.message ?? 'client error'), scrub(props, CLIENT_ERROR_EVENT));
  } catch {
    /* error reporting is best-effort - never let it surface to the user */
  }
}

let errorCaptureReady = false;

/**
 * Register global listeners that forward uncaught errors and unhandled promise
 * rejections to analytics as a structured `$client_error` event. Everything is
 * wrapped so a reporting failure can never break page rendering, identical
 * errors are de-duplicated within a short window to avoid event floods, and the
 * payload's PII is stripped at the central scrub() chokepoint. Routes through
 * track(), so a missing key / disabled analytics is still a silent no-op
 * (consent gate respected).
 */
export function initErrorCapture(): void {
  if (errorCaptureReady || typeof window === 'undefined') return;
  errorCaptureReady = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    reportError(errorEventToProps(event));
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    reportError(rejectionToProps(event));
  });
}
