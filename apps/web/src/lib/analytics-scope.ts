/**
 * Document-scoped analytics state - what makes one document mean one analytics
 * client, one consent decision, one buffer and one page view.
 *
 * `./analytics` used to hold all of that in module-local `let`s, which is only
 * one instance for as long as the bundler gives every importer the same copy of
 * the module. This site has two client entry points that import it - the
 * `src/scripts/chrome` bundle wired from `BaseLayout.astro` and the
 * `PrivacyPreferences.astro` island script - and if a build ever inlines a copy per
 * entry point, module-local state silently becomes two clients, two consent
 * decisions and two buffers in one document: two `$session_start`s, and a page
 * view stranded in a buffer that nothing will ever flush.
 *
 * Hanging the state off a document-scoped global instead removes the assumption
 * rather than relying on it, mirroring the `window.__sdChromeInit` convention in
 * `src/scripts/chrome.ts`. The state is plain data and every mutation is a field
 * assignment, so two copies of `./analytics` operating on the same object behave
 * exactly as one copy does.
 *
 * What this shares is the state whose duplication corrupts counts - the client,
 * the decision, the buffer and the one-per-document dispatches. Module-local state
 * elsewhere (the sticky experiment stamps in `./experiments`) would still be per
 * copy, so an event tracked through a second copy would arrive without its `$exp_*`
 * stamps; that is a strictly better failure than the one this removes, where the
 * event never arrives at all.
 *
 * Pure and injectable (the `./consent` / `./pii` pattern): the host is a
 * parameter, so the guards are unit-tested against a plain object, without a DOM.
 */

import type { ConsentStatus } from './consent.ts';
import type { EventProps } from './pii.ts';

/** Whether events may be sent yet: the resolved consent state of this document. */
export type Decision = ConsentStatus | 'unknown';

/** One event as it waits in the pre-consent buffer, idempotency key included. */
export interface QueuedEvent<Name extends string = string> {
  event: Name;
  props?: EventProps;
}

export interface AnalyticsScope<Client, Name extends string = string> {
  /** The one DevTeam client this document has, or null before consent. */
  client: Client | null;
  decision: Decision;
  /** Events recorded while consent was unknown, flushed on grant. */
  buffer: QueuedEvent<Name>[];
  /** Whether the GA4 tag has been injected into this document. */
  gaReady: boolean;
  /**
   * Whether the uncaught-error listeners are registered on this document. Shared
   * so only one copy of `./analytics` ever registers them - which is also what
   * keeps that copy's error deduper the only one in play.
   */
  errorCaptureReady: boolean;
  /** Keys claimed by `claimOnce`: the one-per-document dispatches already made. */
  claimed: Set<string>;
}

/**
 * The document-scoped global the state hangs off - `window` in the browser, a
 * plain object under the test runner and during the static build.
 */
export interface ScopeHost {
  __sdAnalytics?: unknown;
}

/**
 * The analytics state for this document, created on first call and returned
 * as-is to every caller after that.
 *
 * The cast is the whole point of the module: a second copy of `./analytics` sees
 * the same object through its own structurally identical types, and there is no
 * way to express "typed by whichever copy created it" other than to assert it
 * here, once.
 */
export function analyticsScope<Client, Name extends string = string>(
  host: ScopeHost,
): AnalyticsScope<Client, Name> {
  const existing = host.__sdAnalytics as AnalyticsScope<Client, Name> | undefined;
  if (existing) return existing;
  const created: AnalyticsScope<Client, Name> = {
    client: null,
    decision: 'unknown',
    buffer: [],
    gaReady: false,
    errorCaptureReady: false,
    claimed: new Set(),
  };
  host.__sdAnalytics = created;
  return created;
}

/**
 * The document's analytics client, created by `create` on the first call only.
 *
 * Creating a DevTeam client is what opens a session, so a second client in one
 * document is a second `$session_start` - this is the guard that makes that
 * impossible regardless of how many entry points ask for one.
 */
export function ensureClient<Client, Name extends string>(
  scope: AnalyticsScope<Client, Name>,
  create: () => Client | null,
): Client | null {
  if (scope.client) return scope.client;
  scope.client = create();
  return scope.client;
}

/**
 * True the first time `key` is claimed in this document, false every time after.
 *
 * Used to make the page-view dispatch idempotent per document. The key carries
 * the event name *and* the normalized path, so a genuine same-document
 * navigation to a different path is still counted.
 */
export function claimOnce<Client, Name extends string>(
  scope: AnalyticsScope<Client, Name>,
  key: string,
): boolean {
  if (scope.claimed.has(key)) return false;
  scope.claimed.add(key);
  return true;
}

/** Hold an event until the visitor's consent decision is known. */
export function bufferEvent<Client, Name extends string>(
  scope: AnalyticsScope<Client, Name>,
  item: QueuedEvent<Name>,
): void {
  scope.buffer.push(item);
}

/**
 * Take everything buffered, emptying the buffer in the same step so a second
 * grant in the same document cannot flush the same events twice.
 *
 * Each item comes back exactly as it went in, idempotency key included: an event
 * recorded before consent keeps the `event_id` it was created with rather than
 * being given a fresh one at flush time.
 */
export function drainBuffer<Client, Name extends string>(
  scope: AnalyticsScope<Client, Name>,
): QueuedEvent<Name>[] {
  return scope.buffer.splice(0);
}

/** Discard everything buffered. Called on a consent decline. */
export function dropBuffer<Client, Name extends string>(
  scope: AnalyticsScope<Client, Name>,
): void {
  scope.buffer.length = 0;
}
