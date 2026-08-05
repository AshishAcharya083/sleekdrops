/**
 * PII scrubber — the single chokepoint every analytics payload passes through
 * before it leaves the browser, regardless of which consent path produced it.
 *
 * Strategy is allowlist, not blocklist: only known-structural analytics
 * dimensions survive, so any free-text field a caller forgets about (search
 * terms, form inputs, comment bodies) is dropped by default rather than needing
 * to be named. On the values that do survive we still strip embedded emails and
 * reduce URL-like fields to their path, so query strings never escape.
 *
 * Pure and dependency-free on purpose: it is server-of-record-independent and
 * unit-tested in isolation (see pii.test.ts).
 */

export type EventProps = Record<string, unknown>;

/**
 * Structural analytics dimensions that are safe to send. Anything not listed
 * here is dropped — this is what removes free-text inputs (search, query,
 * comment, message, email, ...) without having to enumerate them.
 */
const ALLOWED_PROPS = new Set<string>([
  'path',
  'url',
  'href',
  'referrer',
  'title',
  'screen',
  'category',
  'slug',
  'brand',
  'retailer',
  'placement',
  'post_type',
  'postType',
  'section',
  'tab',
  'variant',
  'position',
  'cta',
  'link_id',
  'source',
  'medium',
  'campaign',
  'theme',
  'locale',
  'device',
  'count',
  'experiment_key',
  'variant_key',
]);

/**
 * Prefix of the sticky experiment properties (`$exp_<experimentKey>` =
 * `<variantKey>`) stamped onto every event and log emitted after a variant is
 * assigned. Experiment keys are minted in the DevTeam A/B Testing tab rather
 * than declared in code, so this needs a prefix rule instead of a literal name
 * on ALLOWED_PROPS - without it every experiment would be unmeasurable.
 *
 * Safe by construction: both halves are operator-chosen structural ids, never
 * visitor input, and they still go through the same email redaction below.
 */
export const EXPERIMENT_PROP_PREFIX = '$exp_';

/** Allowed fields that may carry a URL and must be reduced to path only. */
const URL_PROPS = new Set<string>(['url', 'href', 'referrer', 'path']);

/**
 * The event name carrying runtime-error diagnostics. Its payload needs fields
 * the generic allowlist deliberately drops as free text, so they are permitted
 * only for this event and still scrubbed (see ERROR_*_PROPS below).
 */
export const CLIENT_ERROR_EVENT = '$client_error';

/**
 * Error-diagnostic fields kept only for CLIENT_ERROR_EVENT. message/stack/source
 * are free text that can embed PII, so URLs in them are reduced to path and
 * emails redacted before they leave the browser.
 */
const ERROR_TEXT_PROPS = new Set<string>(['message', 'stack', 'source']);
/** Numeric error location fields kept only for CLIENT_ERROR_EVENT. */
const ERROR_NUMBER_PROPS = new Set<string>(['lineno', 'colno']);
/** Boolean error flags kept only for CLIENT_ERROR_EVENT. */
const ERROR_BOOL_PROPS = new Set<string>(['handled']);

const URL_WITH_TAIL_RE = /(https?:\/\/[^\s?#'")]+)[^\s'")]*/gi;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Replace any email-shaped substring with a redaction marker. */
export function redactEmails(value: string): string {
  return value.replace(EMAIL_RE, '[redacted]');
}

/**
 * Strip the query string and fragment from any URL embedded in free text (error
 * messages, stack traces, script filenames), keeping the scheme/host/path. This
 * is the path-reduction for fields that are not themselves a bare URL, so search
 * terms, tokens and ids tacked onto a link never escape.
 */
export function stripUrlQueries(value: string): string {
  return value.replace(URL_WITH_TAIL_RE, '$1');
}

/**
 * Reduce a URL or path string to its pathname, dropping the query string and
 * fragment (and host, for absolute URLs). The base lets relative paths parse.
 */
export function urlToPath(value: string): string {
  try {
    return new URL(value, 'http://sd.invalid').pathname;
  } catch {
    return value.split('#')[0].split('?')[0];
  }
}

/**
 * Scrub an outgoing event payload. Returns a new object containing only
 * allowlisted properties, with URL fields reduced to path and emails redacted
 * from every surviving string. Non-primitive values are dropped — they could
 * nest arbitrary PII.
 *
 * `event` widens the allowlist for that event only: CLIENT_ERROR_EVENT also
 * keeps the runtime-error diagnostic fields (message/stack/source/lineno/
 * colno/handled), with the free-text ones URL-reduced and email-redacted.
 *
 * Experiment dimensions survive on every event: `experiment_key` / `variant_key`
 * by name, and the sticky `$exp_*` properties by prefix.
 */
export function scrub(props?: EventProps | null, event?: string): EventProps {
  const out: EventProps = {};
  if (!props) return out;
  const isError = event === CLIENT_ERROR_EVENT;
  for (const [key, raw] of Object.entries(props)) {
    if (raw === null || raw === undefined) continue;
    if (isError && ERROR_TEXT_PROPS.has(key)) {
      if (typeof raw === 'string') out[key] = redactEmails(stripUrlQueries(raw));
    } else if (isError && ERROR_NUMBER_PROPS.has(key)) {
      if (typeof raw === 'number') out[key] = raw;
    } else if (isError && ERROR_BOOL_PROPS.has(key)) {
      if (typeof raw === 'boolean') out[key] = raw;
    } else if (ALLOWED_PROPS.has(key) || key.startsWith(EXPERIMENT_PROP_PREFIX)) {
      if (typeof raw === 'string') {
        const reduced = URL_PROPS.has(key) ? urlToPath(raw) : raw;
        out[key] = redactEmails(reduced);
      } else if (typeof raw === 'number' || typeof raw === 'boolean') {
        out[key] = raw;
      }
    }
  }
  return out;
}
