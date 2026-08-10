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
 * chokepoint - the SDK v0.2.0 has no global-properties API to do it for us. The
 * `theme`, `visit_id` and `event_id` stamps ride the same chokepoint.
 *
 * Everything that has to be one-per-document - the client, the consent decision,
 * the buffer, the GA4 tag, the error listeners, the page-view dispatch - lives on
 * the document-scoped state in `./analytics-scope` rather than in module-local
 * `let`s, so two copies of this module still mean one of each. See that module for
 * why that is not hypothetical here.
 *
 * All console lines are prefixed `[analytics]` so you can filter them in the
 * browser devtools console to watch init / send / consent / error activity.
 */

import { createAnalytics, type AnalyticsClient } from '@getdevteam/analytics-web';

// Explicit .ts extensions: this module is loaded directly by the node --test
// runner (see analytics.test.ts), which needs real specifiers.
import { analyticsEnv } from './analytics-env.ts';
import {
  analyticsScope,
  bufferEvent,
  claimOnce,
  drainBuffer,
  dropBuffer,
  ensureClient,
  type AnalyticsScope,
  type QueuedEvent,
  type ScopeHost,
} from './analytics-scope.ts';
import {
  CONSENT_KEY,
  POLICY_VERSION,
  parseConsent,
  resolveConsent,
  type ConsentPrompt,
  type ConsentStatus,
} from './consent.ts';
import { whenDistinctIdRestored } from './distinct-id.ts';
import { scrub, urlToPath, CLIENT_ERROR_EVENT, type EventProps } from './pii.ts';
import { clearVisit, newEventId, normalizePath, touchVisit, type VisitStorage } from './visit.ts';
import {
  ErrorDeduper,
  errorEventToProps,
  errorSignature,
  rejectionToProps,
  type ErrorProps,
} from './error-capture.ts';
import {
  clearStickyProps,
  restoreStickyProps,
  start as startExperiments,
  stickyProps,
} from './experiments.ts';

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

declare global {
  interface Window {
    __sdAnalytics?: unknown;
  }
}

type Scope = AnalyticsScope<AnalyticsClient, TrackableEvent>;

/** Stand-in host for the static build and the test runner, where there is no `window`. */
const buildHost: ScopeHost = {};

/** This document's analytics state - one client, one decision, one buffer. */
function scope(): Scope {
  return analyticsScope<AnalyticsClient, TrackableEvent>(
    typeof window === 'undefined' ? buildHost : window,
  );
}

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
  const s = scope();
  if (s.gaReady || typeof document === 'undefined') return;
  s.gaReady = true;
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
  // strings (which can carry PII) never reach Google - path only. The page
  // identity is normalized, exactly as the `Page Viewed` event's `path` is, so a
  // slash-suffixed entry URL does not split GA4's page count either; the referrer
  // gets the same plain reduction as the event's, so the two sinks agree.
  w.gtag('config', GA4_ID, {
    page_location: location.origin + normalizePath(location.href),
    page_referrer: urlToPath(document.referrer),
  });
  serverLog('info', 'GA4 initialized -> ' + GA4_ID);
}

/**
 * The document's DevTeam client, created on the first call and shared by every
 * later one. Creating a client is what opens a DevTeam session and so emits
 * `$session_start`, which is why the guard is document-scoped rather than
 * module-scoped: two copies of this module must still produce one session.
 */
function ensureDevteam(): void {
  const s = scope();
  if (s.client) return;
  const { key, host } = analyticsEnv();
  if (!key) {
    serverLog('warn', 'DevTeam analytics NOT configured - PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY is empty');
    return;
  }
  ensureClient(s, () =>
    createAnalytics({
      key,
      host,
      // Page views are emitted explicitly (EVENTS.pageView), so the SDK's own
      // auto-pageview stays off to avoid double-counting.
      trackPageviews: false,
      // Uncaught errors already route through track() as a $client_error event, so
      // the SDK's built-in error capture stays off to avoid duplicate reports.
      autoCaptureErrors: false,
      onError: (error) => console.error('[analytics] DevTeam SDK error:', error),
    }),
  );
  serverLog('info', 'DevTeam analytics initialized -> ' + host);
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

/** sessionStorage, where the visit id lives, or null when it is unavailable. */
function visitStorage(): VisitStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    /* blocked by the browser (private mode, third-party context) */
    return null;
  }
}

/**
 * This visit's session id, stamped on every outgoing event and log.
 *
 * It is the only thing that ties a visit spanning more than one page load into
 * one session: the DevTeam SDK's own `session_id` is per client and per document
 * (see `./visit`), so a reload or a re-navigation reports a second
 * `$session_start` no matter what this site does. `visit_id` is deliberately not
 * called `session_id` - the wire event already carries the SDK's own field under
 * that name, and two disagreeing `session_id`s on one event would be worse than
 * none.
 *
 * Consent-gated at the strictest point available: it returns nothing at all until
 * the decision is `granted`, so no storage is written for a visitor who has not
 * opted in - including on the deny path, which logs through serverLog().
 */
function visitStamp(): EventProps {
  if (scope().decision !== 'granted') return {};
  const storage = visitStorage();
  if (!storage) return {};
  return { visit_id: touchVisit(storage, Date.now()) };
}

function send(item: QueuedEvent<TrackableEvent>): void {
  const client = scope().client;
  if (!client) return;
  // The theme stamp goes in first, so the one call site that carries a more
  // precise per-event value ('Theme Toggled', which records the mode switched
  // to) keeps it; the two agree by construction anyway, since toggleTheme sets
  // the attribute before it tracks. `item.props` carries the event_id minted at
  // the call site. The visit and experiment stamps go in last so no call site can
  // shadow the two keys the platform counts on.
  const props = scrub({ ...themeStamp(), ...item.props, ...visitStamp(), ...stickyProps() }, item.event);
  client.track(item.event, props);
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
  const attrs = { ...themeStamp(), ...attributes, ...visitStamp(), ...stickyProps() };
  scope().client?.log[level](message, Object.keys(attrs).length > 0 ? attrs : undefined);
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
  const client = scope().client;
  if (!client) return;
  whenDistinctIdRestored(client, (distinctId) => {
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

/**
 * Load the analytics SDKs and flush anything queued while consent was pending.
 *
 * Idempotent per document: a second grant - a second copy of this module, or a
 * visitor re-saving their preferences with analytics still on - must not open a
 * second session, inject a second GA4 tag, start a second experiment client or
 * re-flush a buffer.
 */
function applyGrant(): void {
  const s = scope();
  if (s.decision === 'granted') return;
  s.decision = 'granted';
  // First, so every event and log this page emits - the buffered ones included -
  // is attributed to the variants this visitor was bucketed into on an earlier
  // page load.
  restoreStickyProps();
  ensureGa();
  ensureDevteam();
  serverLog('info', 'consent granted - analytics active');
  drainBuffer(s).forEach(send);
  startExperimentsForVisitor();
}

/**
 * The DevTeam SDK's own storage keys, restated here because analytics-core is a
 * transitive dependency (the same reason distinct-id.test.ts restates one). A
 * rename upstream makes the withdrawal path stop clearing them, which the
 * consent test asserts against rather than letting it pass silently.
 */
const SDK_STORAGE_KEYS = ['devteam_analytics.distinct_id', 'devteam_analytics.queue'];

/**
 * Everything the analytics purpose stores in the browser, gone: this site's visit
 * id, and the SDK's device id and any batch it had not yet delivered. Withdrawal
 * has to leave nothing behind for a later page load to restore, which is also
 * what keeps the visit id inside the consent the visitor actually gave.
 */
function forgetAnalyticsStorage(): void {
  clearVisit(visitStorage());
  try {
    SDK_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* storage unavailable - there is nothing stored to forget */
  }
}

/**
 * Take the client off this document, stop it, and leave no analytics storage
 * behind.
 *
 * The order is the whole point. The SDK re-persists its queue on every enqueue,
 * so a client still reachable from the scope writes the storage straight back -
 * the deny path's own `serverLog()` line is enough to do it, which would restore
 * the granted-period events and the device id one statement after they were
 * cleared. Detaching first closes that route for everything downstream, and
 * `shutdown()` stops the flush timer so the SDK cannot write them back later
 * either. That shutdown flushes what was already queued under consent and then
 * settles asynchronously, re-persisting anything it could not deliver, so the
 * storage is cleared once more when it does - unless the visitor has opted back
 * in by then, because that second clear would take the new client's device id and
 * queue with it.
 *
 * Detaching also means a visitor who withdraws and later opts in again gets a
 * fresh client rather than the stopped one, which accepts no further events.
 */
function stopAnalytics(s: Scope): void {
  const client = s.client;
  s.client = null;
  forgetAnalyticsStorage();
  void client
    ?.shutdown()
    .catch(() => {
      /* a failed final flush must not stop the storage from being cleared */
    })
    .then(() => {
      if (s.decision === 'denied') forgetAnalyticsStorage();
    });
}

function applyDeny(): void {
  const s = scope();
  if (s.decision === 'denied') return;
  s.decision = 'denied';
  dropBuffer(s);
  clearStickyProps();
  stopAnalytics(s);
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
  const s = scope();
  if (s.decision === 'denied') return;
  // The idempotency key is minted here, at the moment the call is made, and never
  // at send time: an event held in the consent buffer keeps the id it was created
  // with, so if the same payload reaches the platform twice - a re-sent batch, a
  // second load restoring the SDK's persisted queue - the two copies carry one id
  // and collapse into one event. It always wins over a caller-supplied value.
  const item: QueuedEvent<TrackableEvent> = { event, props: { ...props, event_id: newEventId() } };
  if (s.decision === 'granted') {
    send(item);
    return;
  }
  bufferEvent(s, item);
  console.debug('[analytics] event buffered (awaiting consent):', event);
}

/**
 * Record this document's page view - once, however many times this is called and
 * from whichever entry point.
 *
 * The guard is keyed on the event name plus the normalized path rather than on a
 * bare "already dispatched" flag, so a same-document navigation to a different
 * path is still counted, while a repeat of the same path (a second entry point, a
 * bfcache restore, a re-run of the dispatch path) is not.
 *
 * `path` is the normalized one and is applied last, so the count cannot split
 * across `/deals/foo` and `/deals/foo/` and no caller can override it with the
 * raw location.
 */
export function trackPageView(props?: EventProps): void {
  const path = normalizePath(typeof location === 'undefined' ? '/' : location.pathname) || '/';
  if (!claimOnce(scope(), `${EVENTS.pageView}|${path}`)) {
    console.debug('[analytics] page view already recorded for this document:', path);
    return;
  }
  track(EVENTS.pageView, { ...props, path });
}

/**
 * The consent decision in force for this document, or null while the visitor has
 * not made one. Read by the preferences dialog so reopening it shows what is
 * actually in effect rather than the opt-in default.
 */
export function consentStatus(): ConsentStatus | null {
  const decision = scope().decision;
  return decision === 'unknown' ? null : decision;
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
 *
 * Safe to call more than once per document: the effect it applies is idempotent,
 * so a second entry point calling boot() re-reads the decision without opening a
 * second session or re-flushing the buffer.
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
    scope().client?.log.error(String(props.message ?? 'client error'), scrub(props, CLIENT_ERROR_EVENT));
  } catch {
    /* error reporting is best-effort - never let it surface to the user */
  }
}

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
  if (typeof window === 'undefined') return;
  const s = scope();
  if (s.errorCaptureReady) return;
  s.errorCaptureReady = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    reportError(errorEventToProps(event));
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    reportError(rejectionToProps(event));
  });
}
