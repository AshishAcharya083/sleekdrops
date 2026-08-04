/**
 * Analytics — the single entry point for the admin panel's product tracking,
 * logs and error reports. No component imports the DevTeam SDK directly, the
 * same way apps/web/src/lib/analytics.ts is the website's sole entry point.
 *
 * This is a deliberate simplification of the website's wrapper: same chokepoint
 * and same allowlist discipline, minus GA4 and minus the consent banner. The
 * panel is an internal, token-gated staff tool rather than a public visitor
 * surface, so there is nothing to prompt for - but there is also no user
 * account to identify, since authentication is one shared ADMIN_TOKEN. The
 * operator is therefore identified by a pseudonymous, device-bound UUID kept in
 * localStorage; the admin token (and any derivative of it) is never sent.
 *
 * Every outgoing payload - event property, log attribute or error attribute -
 * passes through scrubProps() first, and every error message and stack through
 * sanitizeError(), so secrets and operator prose cannot leave the browser.
 *
 * All console lines are prefixed `[analytics]` so they can be filtered in
 * devtools to watch init / event / log / error activity.
 */

import { createAnalytics, type AnalyticsClient } from '@getdevteam/analytics-web';

import { ErrorDeduper, errorSignature } from './error-report';
import { redactText, sanitizeError, scrubProps, type EventProps } from './scrub';

export type { EventProps };

/**
 * The panel's event taxonomy. Names are Title Case to match the website's
 * EVENTS map - both apps report into the same DevTeam project, so a second
 * naming convention would make the Analytics tab unusable. Detail lives in
 * properties: one name per interaction, never one per entity or per outcome.
 * apps/admin/docs/analytics-events.md is the canonical reference.
 */
export const EVENTS = {
  pageView: 'Page Viewed',
  topicApproved: 'Topic Approved',
  topicRejected: 'Topic Rejected',
  scoutRunStarted: 'Scout Run Started',
  manualTopicSaved: 'Manual Topic Saved',
  articleActioned: 'Article Actioned',
  articleFeedbackSubmitted: 'Article Feedback Submitted',
  publishedPostDeleted: 'Published Post Deleted',
  settingsSaved: 'Settings Saved',
  connectionSettingChanged: 'Connection Setting Changed',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Request header carrying the client trace id to the agent API. */
export const TRACE_HEADER = 'X-Trace-Id';

/** localStorage key holding the pseudonymous, device-bound operator id. */
const OPERATOR_ID_KEY = 'sleekdrops_operator_id';

// DevTeam Analytics ingest key (dtp_...) and host. Both come from the build
// environment; there is deliberately no fallback in source, and an empty value
// disables the sink silently after one warning.
const ingestKey = import.meta.env.VITE_DEVTEAM_INGEST_KEY ?? '';
const ingestHost = import.meta.env.VITE_DEVTEAM_HOST ?? '';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let client: AnalyticsClient | null = null;
/** Set once the sink has been created or declined, so we decide exactly once. */
let resolved = false;
let booted = false;
/** The tab the operator is on, attached to every payload as context. */
let currentTab = '';

function ensureClient(): AnalyticsClient | null {
  if (resolved) return client;
  resolved = true;
  if (!ingestKey || !ingestHost) {
    console.warn(
      '[analytics] DevTeam analytics disabled — VITE_DEVTEAM_INGEST_KEY / VITE_DEVTEAM_HOST are not set',
    );
    return null;
  }
  try {
    client = createAnalytics({
      key: ingestKey,
      host: ingestHost,
      // Page views are emitted explicitly on boot and on every tab change: the
      // panel is a tabbed SPA with no router, so the SDK's URL-driven auto
      // pageview would only ever see the one URL.
      trackPageviews: false,
      // Uncaught errors route through captureError() below so they share the
      // dedupe window and the scrub chokepoint with every other report.
      autoCaptureErrors: false,
      onError: (error) => console.error('[analytics] DevTeam SDK error:', error),
    });
  } catch (error) {
    // Telemetry must never be able to break the panel it observes.
    console.warn('[analytics] DevTeam analytics disabled — SDK failed to initialise:', error);
  }
  return client;
}

/**
 * A random id that also works outside a secure context. `crypto.randomUUID` is
 * unavailable when the panel is served over plain http from something other
 * than localhost, which is a normal way to reach a self-hosted agent platform.
 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `op-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Merge the ambient panel context into a payload without letting it win. */
function withContext(props?: EventProps): EventProps {
  return scrubProps({ tab: currentTab || undefined, ...props });
}

/**
 * Read (or mint) the pseudonymous operator id. The panel has no user accounts -
 * authentication is one shared ADMIN_TOKEN - so identity is a random UUID bound
 * to this browser. The token itself is a secret and is never used, hashed or
 * prefixed into an identity.
 */
function operatorId(): string {
  try {
    const stored = localStorage.getItem(OPERATOR_ID_KEY);
    if (stored) return stored;
    const minted = randomId();
    localStorage.setItem(OPERATOR_ID_KEY, minted);
    return minted;
  } catch {
    // Storage unavailable (private mode, quota): identity holds for the session.
    return randomId();
  }
}

/** Identify the operator by their device-bound pseudonymous id. */
export function identifyOperator(): void {
  ensureClient()?.identify(operatorId());
}

/**
 * Forget this operator: clears the SDK's distinct id and the stored device id,
 * so the next session starts a fresh pseudonym. Called when the admin token is
 * cleared, which is the panel's only "log out".
 */
export function resetIdentity(): void {
  try {
    localStorage.removeItem(OPERATOR_ID_KEY);
  } catch {
    /* storage unavailable - the SDK reset below is what matters */
  }
  ensureClient()?.reset();
}

/** Record a product event. Safe to call when analytics is disabled. */
export function track(event: EventName, props?: EventProps): void {
  const properties = withContext(props);
  console.info('[analytics] event:', event, properties);
  ensureClient()?.track(event, properties);
}

/**
 * Emit a log line to the console and to the analytics platform's Logs view.
 * Each line carries the session's trace id, so the logs around an error are
 * findable by the same id the panel sends to the agent API.
 */
export function log(level: LogLevel, message: string, attributes?: EventProps): void {
  const attrs = withContext(attributes);
  // The body is authored here, but it interpolates request paths, so it goes
  // through the same redaction as everything else rather than being trusted.
  const body = redactText(message);
  (level === 'debug' ? console.debug : console[level])('[analytics] ' + body, attrs);
  ensureClient()?.log[level](body, attrs);
}

const deduper = new ErrorDeduper();
/** Errors already reported, so a call site re-capturing one api() shipped is a no-op. */
const reported = new WeakSet<object>();

/**
 * Report a failure with its stack trace. This is the one place errors leave the
 * panel: catch blocks, the api() failure path, the React error boundary and the
 * window listeners all land here.
 *
 * Two guards keep the sink clean. An error object is only ever reported once,
 * so a call site that re-captures the error api() already shipped adds no
 * duplicate; and identical signatures are dropped inside the dedupe window, so
 * the 4s poll loop against an unreachable API reports once, not fifteen times a
 * minute. Reporting is best-effort and never surfaces to the operator.
 */
export function captureError(error: unknown, attributes?: EventProps): void {
  try {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    const safe = sanitizeError(error);
    if (!deduper.shouldReport(errorSignature(safe.message, attributes), Date.now())) return;
    const attrs = withContext(attributes);
    console.error('[analytics] error captured:', safe.message, attrs);
    ensureClient()?.captureError(safe, attrs);
  } catch {
    /* error reporting is best-effort - never let it surface to the operator */
  }
}

/**
 * The session trace id to send to the agent API as X-Trace-Id, so a client
 * error found in the Analytics tab leads straight to the server-side log lines
 * of the same request. Empty when analytics is disabled, and api() then omits
 * the header entirely.
 */
export function getTraceId(): string {
  return ensureClient()?.getTraceId() ?? '';
}

/** Record the tab the operator moved to and emit its page view. */
export function viewTab(tab: string): void {
  currentTab = tab;
  track(EVENTS.pageView, { tab, path: location.pathname });
}

function installGlobalErrorCapture(): void {
  window.addEventListener('error', (event: ErrorEvent) => {
    captureError(event.error ?? event.message, { source: 'window_error', handled: false });
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureError(event.reason, { source: 'unhandled_rejection', handled: false });
  });
}

/**
 * Start analytics for the panel: create the client, identify the operator, arm
 * global error capture and emit the first page view. main.tsx calls this before
 * render, so the operator is identified and the trace id exists by the time the
 * first page issues its first request. Idempotent, so a second call is a no-op.
 */
export function boot(tab: string): void {
  if (booted) return;
  booted = true;
  currentTab = tab;
  try {
    ensureClient();
    identifyOperator();
    installGlobalErrorCapture();
    log('info', 'admin panel booted');
    viewTab(tab);
  } catch (error) {
    // main.tsx boots before render, so a throw here would leave a blank panel.
    console.warn('[analytics] boot failed — the panel continues untracked:', error);
  }
}
