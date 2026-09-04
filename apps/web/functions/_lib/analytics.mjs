// DevTeam Analytics sink for Pages Functions — the server-side half of the
// site's telemetry.
//
// Why a hand-rolled sink rather than the browser SDK: the SDK batches on a
// timer, persists a queue to device storage and opens a session per client,
// none of which has any meaning inside a Worker that handles one request and
// exits. What is portable is the wire format, so this speaks it directly —
// `POST <host>/v1/ingest/{events,logs}` with an `X-DevTeam-Key` header, the same
// two endpoints @getdevteam/analytics-core posts to.
//
// Three properties this module exists to guarantee:
//
//  1. **Configuration comes from the runtime environment, never from the repo.**
//     `context.env` is where Cloudflare hands a Function its Pages secrets; an
//     empty or missing key disables the sink silently, exactly as an empty
//     PUBLIC_ ingest key disables it in the browser.
//  2. **Telemetry can never change the response.** Nothing here is awaited on
//     the request path: the caller builds its Response first and hands
//     `deliver()` to `context.waitUntil`. `deliver()` resolves rather than
//     rejects on every failure, and every request is bounded by a timeout, so a
//     slow or broken ingest host cannot touch the redirect's status, its
//     Location header or its latency.
//  3. **No visitor identity leaves here.** A server-side event carries the
//     per-click random click id, the resolved storefront region and the
//     structural dimensions of the link — no cookie, no IP, no user agent, no
//     device or visitor identifier. `distinct_id` is a fixed label naming this
//     surface, not a person.

import { mintClickId } from './click.mjs';

const EVENTS_PATH = '/v1/ingest/events';
const LOGS_PATH = '/v1/ingest/logs';

/** How long an ingest request may take before it is abandoned. */
export const INGEST_TIMEOUT_MS = 2_000;

/**
 * The `distinct_id` every server-side event carries: a constant naming the
 * surface that emitted it. The wire format requires the field; this site has no
 * accounts and the redirect must not identify a visitor, so it is deliberately
 * the same value for every click rather than anything derived from the request.
 */
export const SERVER_DISTINCT_ID = 'go-redirect';

/** `service_name` on the log resource, so these lines are filterable as a group. */
export const SERVICE_NAME = 'sleekdrops-web-go';

/**
 * Read the ingest configuration out of the Function's runtime environment.
 * These are Pages *runtime* variables (uploaded by the deploy workflows with
 * `wrangler pages secret put`), not the build-time `PUBLIC_` values Vite inlines
 * into the browser bundle — those never reach a Function.
 */
function readAnalyticsEnv(env) {
  const read = (name) => (typeof env?.[name] === 'string' ? env[name].trim() : '');
  return { key: read('DEVTEAM_ANALYTICS_INGEST_KEY'), host: read('DEVTEAM_ANALYTICS_HOST').replace(/\/+$/, '') };
}

/** True when both an ingest key and a host are present. */
function isConfigured({ key, host }) {
  return key !== '' && host !== '';
}

/** The platform's trace id shape: a session id with its dashes stripped. */
export function traceIdFrom(traceId, clickId) {
  return traceId ?? clickId.replace(/-/g, '');
}

/**
 * Drop keys with no value, so an absent placement is an absent dimension rather
 * than a `null` the reporting layer has to special-case.
 */
function defined(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

/**
 * Build one wire event. `session_id` is the click id: a click handled by a
 * Worker is its own session, and the id is random per click, so this carries no
 * more identity than the click id already does.
 */
function buildEvent(name, properties, { clickId, eventId, nowMs }) {
  return {
    event_id: eventId,
    name,
    distinct_id: SERVER_DISTINCT_ID,
    session_id: clickId,
    timestamp: new Date(nowMs).toISOString(),
    properties: defined(properties),
  };
}

/** Build one wire log line, carrying the trace id its event carries. */
function buildLog(severity, body, attributes, { traceId, nowMs }) {
  return {
    timestamp: new Date(nowMs).toISOString(),
    severity,
    body,
    trace_id: traceId,
    attributes: defined(attributes),
  };
}

/** An AbortSignal that fires after `ms`, or nothing where the API is absent. */
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * Collect events and log lines for one request, then deliver them in the
 * background.
 *
 * `deliver()` is what the caller hands to `context.waitUntil`. It never throws
 * and never rejects: an unreachable host, a rejected batch and a timeout are all
 * the same outcome here — the telemetry is lost and the visitor is unaffected.
 */
export function createTelemetry(env, options = {}) {
  const config = readAnalyticsEnv(env);
  const now = options.now ?? (() => Date.now());
  const mintId = options.mintId ?? mintClickId;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const events = [];
  const logs = [];

  const post = async (path, payload) => {
    const response = await fetchImpl(`${config.host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevTeam-Key': config.key },
      body: JSON.stringify(payload),
      signal: timeoutSignal(INGEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${config.host}${path} rejected the batch with HTTP ${response.status}`);
    }
  };

  return {
    event(name, properties, click) {
      events.push(
        buildEvent(name, properties, {
          clickId: click.clickId,
          eventId: mintId(),
          nowMs: now(),
        }),
      );
    },

    log(severity, body, attributes, click) {
      logs.push(
        buildLog(severity, body, attributes, {
          traceId: traceIdFrom(click.traceId, click.clickId),
          nowMs: now(),
        }),
      );
    },

    async deliver() {
      if (!isConfigured(config) || (events.length === 0 && logs.length === 0)) return;
      const batches = [];
      if (events.length > 0) batches.push(post(EVENTS_PATH, { sent_at: new Date(now()).toISOString(), events }));
      if (logs.length > 0) batches.push(post(LOGS_PATH, { resource: { service_name: SERVICE_NAME }, logs }));
      const settled = await Promise.allSettled(batches);
      settled
        .filter((outcome) => outcome.status === 'rejected')
        .forEach((outcome) => console.error('[analytics] ingest failed:', String(outcome.reason)));
    },
  };
}
