/**
 * Analytics - the single entry point for product tracking, and the wiring that
 * gates it behind the visitor's consent choice.
 *
 * Nothing reaches DevTeam analytics or GA4 until the visitor has opted in. Every
 * event is queued in an in-memory buffer while consent is unknown; on grant the
 * buffer flushes and subsequent events send live, on deny (including a GPC/DNT
 * signal) the buffer is dropped and nothing is ever sent. Every outgoing payload
 * - buffered or live - runs through the central PII scrub() first. A withdrawal
 * arriving after a grant - the footer's preferences control makes that reachable on
 * any page - stops both sinks and the A/B testing SDK where they stand and clears
 * what each of them stored.
 *
 * The consent choice persists to localStorage under `sd-consent`, mirroring the
 * `sd-theme` handling in chrome.ts; we re-prompt only when the stored policy
 * version is older than the current one. The decision table itself lives in the
 * pure, unit-tested `./consent` module.
 *
 * That record holds one decision per purpose category, and this module acts on
 * exactly one of them - `analytics`. The advertising category is written here
 * too, because a single record is what keeps the categories in step, but it is
 * read and enforced by `./ads`, which has no dependency on this module or on the
 * analytics SDKs.
 *
 * Two sinks hang off that one gate and off one payload. `send()` scrubs an event
 * once and hands the result to the DevTeam client and, through the `./ga`
 * chokepoint, to GA4 - so the two never disagree about what was sent, and neither
 * depends on the other being configured. Which GA4 property receives it is
 * per-environment build configuration (`./ga-env`), never a constant: develop and
 * production report into their own properties and a local `pnpm dev`, which has
 * no measurement id, reports into nothing.
 *
 * A/B testing hangs off the same gate at both ends: `./experiments` is started
 * from the grant path with the DevTeam SDK's own distinct id and stopped from the
 * withdrawal path, and the sticky `$exp_*` stamps it hands back are merged into
 * every outgoing payload at the send() / serverLog() chokepoint - the SDK v0.2.0
 * has no global-properties API to do it for us. The `theme`, `visit_id` and
 * `event_id` stamps ride the same chokepoint.
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
  uniformGrants,
  type ConsentGrants,
  type ConsentPrompt,
  type ConsentStatus,
} from './consent.ts';
import { sendGa, setGaOptOut, startGa, stopGa } from './ga.ts';
import { hasPrivacySignal } from './privacy-signal.ts';
import { whenDistinctIdRestored } from './distinct-id.ts';
import { scrub, CLIENT_ERROR_EVENT, type EventProps } from './pii.ts';
import { clearVisit, newEventId, normalizePath, touchVisit, type VisitStorage } from './visit.ts';
import {
  ErrorDeduper,
  errorEventToProps,
  errorSignature,
  errorToProps,
  rejectionToProps,
  type ErrorProps,
} from './error-capture.ts';
import {
  restoreStickyProps,
  start as startExperiments,
  stickyProps,
  stop as stopExperiments,
} from './experiments.ts';

export type { EventProps, ConsentPrompt };

/**
 * The product event taxonomy. Every track call uses one of these names so the
 * vocabulary stays consistent between code and docs/analytics-events.md - the
 * doc is the canonical reference for properties and owning screens.
 */
export const EVENTS = {
  pageView: 'Page Viewed',
  heroCtaClick: 'Hero CTA Clicked',
  listingViewed: 'Listing Viewed',
  dealCardClick: 'Deal Card Clicked',
  promoCardClick: 'Promo Card Clicked',
  promoCodeCopied: 'Promo Code Copied',
  affiliateClick: 'Affiliate Link Clicked',
  // Emitted by the /go Pages Function, not by this module - it is the
  // ad-block-proof count of redirects actually served, and it lives in the
  // taxonomy here so the one vocabulary covers both halves of the click.
  affiliateRedirect: 'Affiliate Redirect Served',
  articleRead: 'Article Read',
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

function readConsent() {
  try {
    return parseConsent(localStorage.getItem(CONSENT_KEY));
  } catch {
    return null;
  }
}

function writeConsent(grants: ConsentGrants): void {
  try {
    const record = { v: POLICY_VERSION, grants, ts: Date.now() };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch (error) {
    // Storage unavailable (private mode, quota). Consent still holds for this
    // page load, but the visitor will be re-prompted on the next one, so the
    // failure is reported rather than swallowed - it is the difference between
    // "nobody accepts" and "everybody is asked twice".
    captureError(error, { feature: 'consent-storage' });
  }
}

/**
 * Load gtag.js for this document's build, once.
 *
 * Withdrawal cannot take the tag away again: the script stays in the DOM,
 * `window.gtag` stays callable, and it goes on emitting on its own (a
 * `user_engagement` on every visibility change and unload, plus whatever enhanced
 * measurement the property has switched on). That is why the grant path pairs
 * this with the opt-out flag rather than relying on the load guard - see
 * `./ga`, which owns both.
 */
function ensureGa(): void {
  const s = scope();
  if (s.gaReady) return;
  s.gaReady = startGa(serverLog);
}

/**
 * The heading of the feedback dialog. It is site copy, so it lives here and
 * reaches the widget through the SDK's own `feedback.title` option rather than
 * through the layout patch in patches/: the patch goes away the day the SDK
 * releases the wide modal, and the wording must not go with it.
 */
const FEEDBACK_TITLE = 'Send feedback by drawing or describing';

/**
 * The document's DevTeam client, created on the first call and shared by every
 * later one. Creating a client is what opens a DevTeam session and so emits
 * `$session_start`, which is why the guard is document-scoped rather than
 * module-scoped: two copies of this module must still produce one session.
 */
function ensureDevteam(): void {
  const s = scope();
  if (s.client) return;
  const { key, host, feedback: allowUserFeedback } = analyticsEnv();
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
      // In-app feedback: a floating button that screenshots the page, lets the
      // visitor circle what is wrong and sends it to the analytics project. It
      // appears only after consent, because this is the only place a client is
      // created and the grant path is the only caller.
      allowUserFeedback,
      feedback: { title: FEEDBACK_TITLE },
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
  // The theme stamp goes in first, so the one call site that carries a more
  // precise per-event value ('Theme Toggled', which records the mode switched
  // to) keeps it; the two agree by construction anyway, since toggleTheme sets
  // the attribute before it tracks. `item.props` carries the event_id minted at
  // the call site. The visit and experiment stamps go in last so no call site can
  // shadow the two keys the platform counts on.
  const props = scrub({ ...themeStamp(), ...item.props, ...visitStamp(), ...stickyProps() }, item.event);
  // Both sinks from the one scrubbed payload, and neither conditional on the
  // other. GA4 goes first and outside the client guard on purpose: an empty
  // DevTeam ingest key is a supported state (it disables that sink silently), and
  // reading it as "send nothing anywhere" is what would leave a correctly
  // configured GA4 property receiving page views and not one funnel event.
  sendGa(item.event, props, serverLog);
  const client = scope().client;
  if (!client) return;
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
      captureError,
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
  // The DevTeam client before the GA4 tag, so that `serverLog` has somewhere to
  // forward to by the time the tag reports whether it came up. Which property a
  // build tagged the document with - or that it had no measurement id to tag it
  // with at all - is the first thing worth knowing when a GA4 report reads empty,
  // and the Logs view is where it is reachable after the fact; console-only, it
  // is gone the moment the visitor closes the tab.
  ensureDevteam();
  setGaOptOut(false);
  ensureGa();
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
  // Everything the grant started, not just the DevTeam sink: withdrawal is
  // reachable from the footer control long after a grant, so the GA4 tag can be
  // running when it happens and A/B testing can be holding an open subscription
  // to the flag host - one whose next payload would bucket the visitor and stamp
  // an assignment on them after they opted out.
  stopExperiments();
  stopGa();
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
 * The analytics consent decision in force for this document, or null while the
 * visitor has not made one. Read by the preferences dialog so reopening it shows
 * what is actually in effect rather than the opt-in default. The advertising
 * category has its own reader, `isAdsGranted` in `./ads`.
 */
export function consentStatus(): ConsentStatus | null {
  const decision = scope().decision;
  return decision === 'unknown' ? null : decision;
}

/**
 * Persist an explicit per-category decision and enforce it.
 *
 * The record is the only place a category is decided, so this is the one writer:
 * the advertising category has no runtime effect here (`./ads` reads the same
 * record on the pages that carry a slot), but it is written in the same object
 * as the analytics one so a save can never leave the two out of step.
 */
export function setConsent(grants: ConsentGrants): void {
  writeConsent(grants);
  if (grants.analytics === 'granted') applyGrant();
  else applyDeny();
}

/** Persist an explicit opt-in to analytics - and to analytics only - and start sending. */
export function grantConsent(): void {
  setConsent({ analytics: 'granted', ads: 'denied' });
}

/** Persist an explicit opt-out of every category and drop anything buffered. */
export function denyConsent(): void {
  setConsent(uniformGrants('denied'));
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
  const { prompt, effects } = resolveConsent(readConsent(), hasPrivacySignal());
  if (effects.analytics === 'grant') applyGrant();
  else if (effects.analytics === 'deny') applyDeny();
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
 * Report a handled failure - one caught in a `catch` block, an API error
 * handler or an error boundary - with its message and a truncated stack trace.
 *
 * Routes through exactly the same pipeline an uncaught error does: the consent
 * gate (nothing is sent, stored or logged before the visitor opts in), the
 * dedupe window (a fault firing in a loop reports once), and the scrub()
 * chokepoint (URLs in the message and the stack are reduced to path, emails
 * redacted, and any attribute not on the allowlist dropped). It emits both the
 * `$client_error` event and an error-level log, so the failure is findable in
 * the platform's Logs view beside the log lines around it - which is what makes
 * a stack trace investigable rather than merely counted.
 *
 * `attributes` is for structural context - `{ feature: 'clipboard' }`, a screen,
 * a slug - never for anything free-form.
 *
 * Never throws: a reporting failure must not surface to the user or break
 * rendering, which is what lets a call site use it in place of an empty catch.
 */
export function captureError(error: unknown, attributes?: EventProps): void {
  reportError(errorToProps(error, attributes));
}

/**
 * This session's analytics trace id, or an empty string before consent (there
 * is no client, and so no session, until then).
 *
 * Every log line the SDK sends already carries it. Sending it on to the site's
 * own backend - here, on the `/go` redirect URL - is what puts a client-side
 * error and the server-side log of the request that preceded it under one key.
 */
export function getTraceId(): string {
  try {
    return scope().client?.getTraceId() ?? '';
  } catch {
    /* the SDK reports its own failures through onError - never break a caller */
    return '';
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
