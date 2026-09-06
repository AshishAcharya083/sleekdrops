/**
 * Visit identity and per-event idempotency - the two values that make a
 * duplicate top-of-funnel event either impossible or collapsible.
 *
 * Both exist because of how @getdevteam/analytics-web 0.2.0 behaves, which was
 * read out of the SDK source rather than assumed:
 *
 *  - **The SDK's session is per client, in memory, and not restorable.** It mints
 *    a session id lazily in a closure, emits `$session_start` before the first
 *    event of that session, and `ClientConfig` exposes no session option and no
 *    storage key for it. So every document load opens a fresh SDK session, and a
 *    visit that spans two loads - a reload, a re-navigation, a redirect chain -
 *    reports two `$session_start`s that nothing in the payload ties together.
 *    `visit_id` is that tie: one randomly generated id, persisted for the tab,
 *    stamped on every event, so one visit is countable as one session.
 *  - **The SDK persists its unflushed queue to localStorage and restores it into
 *    the next client.** That is what merged two loads' events into a single
 *    ingest batch and made them read as a same-instant duplicate; it is also the
 *    path by which a batch whose response was lost (a `keepalive` flush on
 *    pagehide) is re-sent verbatim on the next load. `event_id` is minted at the
 *    call site, travels inside the payload, and therefore survives both our own
 *    consent buffer and the SDK's persisted queue - so a re-send carries the
 *    same id and the platform can collapse it.
 *
 * Pure and injectable (the `./consent` / `./pii` pattern): storage, the clock and
 * the randomness source are all parameters, so the rules are unit-tested without
 * a DOM.
 */

// Explicit .ts extension: this module is loaded directly by the node --test
// runner (see visit.test.ts), which needs a real specifier.
import { urlToPath } from './pii.ts';

/**
 * sessionStorage key holding this visit's session id, in the `sd-` family
 * alongside `sd-consent` / `sd-theme` / `sd-exp`. Underscored rather than
 * hyphenated because it is the name the storage inventory in
 * `src/pages/privacy.astro` publishes to visitors.
 *
 * sessionStorage, not localStorage: a visit is one tab, and the browser clearing
 * the item when the tab closes is a shorter retention than any expiry stamp we
 * could implement ourselves.
 */
export const VISIT_KEY = 'sd_sid';

/**
 * Inactivity that ends a visit, matching the DevTeam SDK's own 30-minute session
 * window so the site's visit and the platform's session expire together.
 */
export const VISIT_IDLE_MS = 30 * 60 * 1000;

/** The synchronous storage surface this module needs - `sessionStorage` in the browser. */
export interface VisitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The `crypto` surface id minting prefers, narrowed to what it uses. */
export interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

interface VisitRecord {
  id: string;
  ts: number;
}

/**
 * The shape an id must have to be stamped onto an outgoing event: a canonical
 * UUID's alphabet and length. Applied on the way *out* of storage, so a corrupt
 * or hostile `sd_sid` written by anything else on the origin cannot smuggle a
 * value of its choosing into the analytics payload - the same discipline
 * `isExperimentStamp` applies to the flag payload.
 *
 * The bound is also the strictest per-event id limit among the platforms that
 * dedupe on one (Mixpanel's `$insert_id`: at most 36 bytes, alphanumeric or `-`).
 */
const ID_RE = /^[A-Za-z0-9-]{1,36}$/;

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mint a UUID v4 to use as a per-event idempotency key.
 *
 * `crypto.randomUUID` is the preferred source but is exposed only in a secure
 * context, so a page served over plain http (local development, a preview over
 * http) has to fall back - first to `crypto.getRandomValues`, then to
 * `Math.random`. A weaker source is acceptable here and only here: the value's
 * job is to be distinct from the other ids in a 24-hour dedupe window, not to be
 * unguessable, and it is never derived from the visitor, the device or any stored
 * identifier.
 */
export function newEventId(source: RandomSource | undefined = globalThis.crypto): string {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
  } catch {
    /* randomUUID exists but refused (insecure context) - fall through */
  }
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    if (typeof source?.getRandomValues === 'function') {
      source.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    /* getRandomValues refused - fall through to the non-crypto source */
  }
  if (!filled) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

/**
 * The one spelling of a path this site counts under.
 *
 * `astro.config.mjs` sets `trailingSlash: 'never'`, so `/deals/foo/` and
 * `/deals/foo` are the same page and a slash-suffixed entry URL redirects to the
 * bare one. Without collapsing them, that redirect splits the page-view count
 * across two paths and defeats a dispatch guard keyed on the path.
 *
 * An empty value stays empty rather than becoming the root, so an absent referrer
 * is reported as absent (see `urlToPath`); the root itself normalizes to `/`.
 */
export function normalizePath(value: string): string {
  const path = urlToPath(value);
  if (path === '') return '';
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function readVisit(storage: VisitStorage): VisitRecord | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(VISIT_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, ts } = parsed as Partial<VisitRecord>;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return { id, ts: typeof ts === 'number' ? ts : 0 };
  } catch {
    /* storage unavailable or corrupt - treated as no visit on file */
  }
  return null;
}

/**
 * The current visit's session id, continuing the stored one when the visit is
 * still live and minting a new one otherwise, and rolling the inactivity stamp
 * either way.
 *
 * Called once per outgoing event, which is what makes the 30-minute window
 * rolling rather than absolute: a visitor reading for an hour stays in one visit,
 * and a tab left open overnight starts a new one.
 *
 * The id comes from the same UUID v4 source as an event id, and like it is random
 * per mint rather than derived from the visitor or the device.
 *
 * Callers must have the analytics category granted before calling this - it
 * writes to storage.
 */
export function touchVisit(
  storage: VisitStorage,
  nowMs: number,
  mintId: () => string = newEventId,
): string {
  const stored = readVisit(storage);
  // A stored stamp in the future (a clock correction between loads) continues the
  // visit rather than splitting it; only real inactivity ends one.
  const live = stored !== null && nowMs - stored.ts <= VISIT_IDLE_MS;
  const id = live ? stored.id : mintId();
  try {
    storage.setItem(VISIT_KEY, JSON.stringify({ id, ts: nowMs } satisfies VisitRecord));
  } catch {
    /* storage unavailable (private mode, quota) - the id holds for this load */
  }
  return id;
}

/** Forget the visit id. Called the moment the visitor declines or withdraws. */
export function clearVisit(storage: VisitStorage | null): void {
  try {
    storage?.removeItem(VISIT_KEY);
  } catch {
    /* storage unavailable - nothing is sent on a decline anyway */
  }
}
