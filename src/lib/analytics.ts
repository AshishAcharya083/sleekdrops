/**
 * Analytics - the single entry point for product tracking.
 *
 * Wraps mixpanel-browser so tracking calls never touch the SDK directly:
 * the token lives in config, init runs once client-side from chrome.ts, and
 * every call is a safe no-op until init() has succeeded. When the token is
 * empty (local/dev, or analytics disabled) nothing loads and nothing throws.
 */

import mixpanel from 'mixpanel-browser';

export type EventProps = Record<string, unknown>;

const token = import.meta.env.PUBLIC_Mixpanel__ProjectToken;

let ready = false;

/**
 * Initialise Mixpanel once. Safe to call on every page load - repeat calls
 * after the first are ignored. A missing/empty token is a deliberate no-op so
 * environments without analytics (local, preview) just skip tracking.
 */
export function init(): void {
  if (ready || !token) return;
  mixpanel.init(token, { track_pageview: true, persistence: 'localStorage' });
  ready = true;
}

/**
 * Record an event. No-op until init() has run with a valid token, so callers
 * never need to guard their tracking calls.
 */
export function track(event: string, props?: EventProps): void {
  if (!ready) return;
  mixpanel.track(event, props);
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
