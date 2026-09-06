/**
 * Property scrub — the single chokepoint every admin analytics payload passes
 * through before it leaves the browser, whether it is an event, a log line or
 * an error attribute bag.
 *
 * This is the admin counterpart of apps/web/src/lib/pii.ts and follows the same
 * discipline: allowlist, not blocklist. Only known-structural panel dimensions
 * survive, so the things that must never be reported - the admin bearer token,
 * the Gemini API key, the Claude OAuth token, and every piece of operator prose
 * (topic titles, agent instructions, editor feedback, reference-material bodies)
 * - are dropped by default rather than by being enumerated. On the values that
 * do survive we still redact embedded emails and strip query strings, so an id
 * or token smuggled onto a URL never escapes either.
 *
 * Pure and dependency-free on purpose: it is unit-tested in isolation (see
 * scrub.test.ts).
 */

export type EventProps = Record<string, unknown>;

/**
 * Structural panel dimensions that are safe to send. Anything not listed here
 * is dropped — this is what removes free text (topic titles, instructions,
 * feedback, reference bodies) and every credential field without having to name
 * them one by one.
 */
const ALLOWED_PROPS = new Set<string>([
  // where the operator was / what they touched
  'tab',
  'path',
  'route',
  'surface',
  'action',
  'field',
  'mode',
  'source',
  // entity dimensions (opaque ids and enums, never operator prose)
  'topic_id',
  'article_id',
  'slug',
  'category',
  'post_type',
  'stage',
  'status',
  // request dimensions
  'method',
  'http_status',
  'duration_ms',
  'server_trace_id',
  'handled',
  // shape-of-the-payload counters and flags — never the payload itself
  'count',
  'reference_count',
  'removed_links',
  'feedback_length',
  'instructions_provided',
  'hero_image_provided',
  'value_present',
  // settings dimensions (enums, counts and set/not-set flags only)
  'publish_mode',
  'prose_engine',
  'worker_enabled',
  'scout_interval_hours',
  'max_revision_rounds',
  'models_configured',
  'gemini_key_set',
  'claude_token_set',
]);

/** Allowed fields that may carry a URL and must be reduced to a path. */
const PATH_PROPS = new Set<string>(['path', 'route']);

/**
 * Allowed fields that are diagnostic free text rather than a dimension. They
 * survive because they are the only way to place an error in the component
 * tree, but they get the full redaction treatment and a length cap.
 */
const TEXT_PROPS = new Set<string>(['component_stack']);

/** Max characters kept from a free-text diagnostic field before truncation. */
export const TEXT_LIMIT = 2000;

const URL_WITH_TAIL_RE = /(https?:\/\/[^\s?#'")]+)[^\s'")]*/gi;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Replace any email-shaped substring with a redaction marker. */
export function redactEmails(value: string): string {
  return value.replace(EMAIL_RE, '[redacted]');
}

/**
 * Strip the query string and fragment from any URL embedded in free text (error
 * messages, stack traces, component stacks), keeping scheme/host/path. Bearer
 * tokens and ids tacked onto a link never escape this way.
 */
export function stripUrlQueries(value: string): string {
  return value.replace(URL_WITH_TAIL_RE, '$1');
}

/**
 * Reduce a URL or path string to its pathname, dropping query string, fragment
 * and (for absolute URLs) host. The base lets relative paths parse.
 */
export function toPath(value: string): string {
  try {
    return new URL(value, 'http://admin.invalid').pathname;
  } catch {
    return value.split('#')[0].split('?')[0];
  }
}

/**
 * Redact a free-text diagnostic string: query strings stripped, emails removed,
 * length capped. Used for error messages, stacks and log bodies - the payloads
 * that are worth shipping verbatim but can still pick up something sensitive.
 */
export function redactText(value: string): string {
  return redactEmails(stripUrlQueries(value)).slice(0, TEXT_LIMIT);
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
}

/**
 * Recognise an error by shape rather than by `instanceof`. An error crossing a
 * realm boundary - thrown inside an iframe, or surfaced by a library that
 * builds its own error objects - fails `instanceof Error`, and treating it as a
 * plain value would throw away the very message and stack we are reporting for.
 */
function asErrorLike(value: unknown): ErrorLike | null {
  if (value instanceof Error) return value;
  const candidate = value as ErrorLike | null;
  return typeof candidate === 'object' && candidate !== null && typeof candidate.message === 'string'
    ? candidate
    : null;
}

/**
 * Turn an unknown thrown value into an `Error` whose message and stack have
 * been through the same redaction pass as event properties. A fresh `Error` is
 * built rather than mutating the caught one, so the panel's own error banner
 * keeps the original text while analytics only ever sees the redacted copy.
 * Values thrown without a stack (a bare string, a rejected non-Error) still
 * ship one - the stack of the `Error` constructed here - so every capture is
 * traceable to a code path.
 */
export function sanitizeError(error: unknown): Error {
  const source = asErrorLike(error);
  const message = source ? String(source.message) : describeValue(error);
  const safe = new Error(redactText(message || 'Unknown error'));
  if (typeof source?.name === 'string' && source.name) safe.name = source.name;
  if (typeof source?.stack === 'string' && source.stack) safe.stack = redactText(source.stack);
  return safe;
}

/**
 * Scrub an outgoing payload. Returns a new object holding only allowlisted
 * properties: path-like fields reduced to a path, free-text diagnostics
 * redacted and truncated, emails removed from every surviving string.
 * Non-primitive values are dropped — they could nest arbitrary secrets.
 */
export function scrubProps(props?: EventProps | null): EventProps {
  const out: EventProps = {};
  if (!props) return out;
  for (const [key, raw] of Object.entries(props)) {
    if (raw === null || raw === undefined) continue;
    if (TEXT_PROPS.has(key)) {
      if (typeof raw === 'string') out[key] = redactText(raw);
      continue;
    }
    if (!ALLOWED_PROPS.has(key)) continue;
    if (typeof raw === 'string') {
      out[key] = redactEmails(PATH_PROPS.has(key) ? toPath(raw) : raw);
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    }
  }
  return out;
}
