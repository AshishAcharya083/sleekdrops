/**
 * Analytics - the single entry point for product tracking, and the wiring that
 * gates it behind the visitor's consent choice.
 *
 * Nothing reaches Mixpanel or GA4 until the visitor has opted in. Every event
 * is queued in an in-memory buffer while consent is unknown; on grant the
 * buffer flushes and subsequent events send live, on deny (including a GPC/DNT
 * signal) the buffer is dropped and nothing is ever sent. Every outgoing
 * payload - buffered or live - runs through the central PII scrub() first.
 *
 * The consent choice persists to localStorage under `sd-consent`, mirroring the
 * `sd-theme` handling in chrome.ts; we re-prompt only when the stored policy
 * version is older than the current one. The decision table itself lives in the
 * pure, unit-tested `./consent` module.
 */

import mixpanel from 'mixpanel-browser';

import {
  CONSENT_KEY,
  POLICY_VERSION,
  parseConsent,
  resolveConsent,
  type ConsentPrompt,
  type ConsentStatus,
} from './consent';
import { scrub, urlToPath, type EventProps } from './pii';

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
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const token = import.meta.env.PUBLIC_Mixpanel__ProjectToken;

type Decision = ConsentStatus | 'unknown';

interface QueuedEvent {
  event: string;
  props?: EventProps;
}

let decision: Decision = 'unknown';
let mixpanelReady = false;
let gaReady = false;
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

function ensureMixpanel(): void {
  if (mixpanelReady || !token) return;
  mixpanel.init(token, {
    // Page views are emitted explicitly (see EVENTS.pageView) with screen
    // context, so the SDK's contextless auto-pageview is turned off.
    track_pageview: false,
    persistence: 'localStorage',
    // Funnel-step events fire from click handlers immediately before the
    // browser navigates (deal cards, affiliate "View deal" buttons). Batching
    // would queue those events and lose them on unload, so it's disabled and
    // requests go out via sendBeacon, which survives the page transition.
    batch_requests: false,
    api_transport: 'sendBeacon',
    // The SDK auto-attaches URL/referrer defaults that carry raw query
    // strings; we send our own path-reduced values instead.
    property_blacklist: [
      '$current_url',
      '$referrer',
      '$initial_referrer',
      '$referring_domain',
      '$initial_referring_domain',
    ],
  });
  mixpanelReady = true;
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
  // strings (which can carry PII) never reach Google - path only, like Mixpanel.
  w.gtag('config', GA4_ID, {
    page_location: location.origin + urlToPath(location.href),
    page_referrer: document.referrer ? urlToPath(document.referrer) : '',
  });
}

function send(item: QueuedEvent): void {
  if (!mixpanelReady) return;
  mixpanel.track(item.event, scrub(item.props));
}

/** Load the analytics SDKs and flush anything queued while consent was pending. */
function applyGrant(): void {
  decision = 'granted';
  ensureMixpanel();
  ensureGa();
  const queued = buffer;
  buffer = [];
  queued.forEach(send);
}

function applyDeny(): void {
  decision = 'denied';
  buffer = [];
}

/**
 * Record an event. While consent is unknown the event is buffered in memory;
 * once granted it (and anything buffered) sends live; once denied it is
 * dropped. Callers never need to guard their tracking calls.
 */
export function track(event: string, props?: EventProps): void {
  if (decision === 'denied') return;
  if (decision === 'granted') {
    send({ event, props });
    return;
  }
  buffer.push({ event, props });
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

/** Max characters kept from a stack trace before truncation. */
const STACK_LIMIT = 2000;

/** Window during which an identical error signature is reported at most once. */
const DEDUPE_WINDOW_MS = 10_000;

/** Cap on distinct signatures tracked, so the dedupe map can't grow unbounded. */
const DEDUPE_MAX_KEYS = 100;

const lastReported = new Map<string, number>();

/**
 * Drop query strings and fragments from any URL so we never ship PII (search
 * terms, tokens, ids) that callers may have tacked onto a link.
 */
function stripPii(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#'")]+)[^\s'")]*/gi, '$1');
}

/**
 * Has this exact error been reported within the dedupe window? Records the
 * signature when it hasn't, so the next identical error inside the window is
 * suppressed. Keeps the page from flooding Mixpanel when an error fires in a
 * tight loop (e.g. an animation frame or scroll handler).
 */
function shouldReport(signature: string, now: number): boolean {
  const previous = lastReported.get(signature);
  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) return false;

  if (!lastReported.has(signature) && lastReported.size >= DEDUPE_MAX_KEYS) {
    lastReported.clear();
  }
  lastReported.set(signature, now);
  return true;
}

function reportError(props: EventProps & { message: string }): void {
  try {
    const now = Date.now();
    const signature = `${props.message}|${props.source ?? ''}|${props.lineno ?? ''}`;
    if (!shouldReport(signature, now)) return;
    track('$client_error', props);
  } catch {
    /* error reporting is best-effort - never let it surface to the user */
  }
}

let errorCaptureReady = false;

/**
 * Register global listeners that forward uncaught errors and unhandled promise
 * rejections to Mixpanel as a structured `$client_error` event. Everything is
 * wrapped so a reporting failure can never break page rendering, payloads are
 * stripped of query-string PII, and identical errors are de-duplicated within a
 * short window to avoid event floods. Routes through track(), so a missing
 * token / disabled analytics is still a silent no-op (consent gate respected).
 */
export function initErrorCapture(): void {
  if (errorCaptureReady || typeof window === 'undefined') return;
  errorCaptureReady = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const stack = event.error instanceof Error ? event.error.stack : undefined;
    reportError({
      message: stripPii(event.message || 'Unknown error'),
      source: event.filename ? stripPii(event.filename) : undefined,
      lineno: event.lineno || undefined,
      colno: event.colno || undefined,
      stack: stack ? stripPii(stack).slice(0, STACK_LIMIT) : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    const stack = reason instanceof Error ? reason.stack : undefined;
    reportError({
      message: stripPii(message || 'Unhandled promise rejection'),
      handled: false,
      stack: stack ? stripPii(stack).slice(0, STACK_LIMIT) : undefined,
    });
  });
}
