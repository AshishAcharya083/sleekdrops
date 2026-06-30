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
]);

/** Allowed fields that may carry a URL and must be reduced to path only. */
const URL_PROPS = new Set<string>(['url', 'href', 'referrer', 'path']);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Replace any email-shaped substring with a redaction marker. */
export function redactEmails(value: string): string {
  return value.replace(EMAIL_RE, '[redacted]');
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
 */
export function scrub(props?: EventProps | null): EventProps {
  const out: EventProps = {};
  if (!props) return out;
  for (const [key, raw] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(key) || raw === null || raw === undefined) continue;
    if (typeof raw === 'string') {
      const reduced = URL_PROPS.has(key) ? urlToPath(raw) : raw;
      out[key] = redactEmails(reduced);
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    }
  }
  return out;
}
