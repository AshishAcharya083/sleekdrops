// Click context for /go/<slug> — pure logic, no I/O.
//
// Everything the redirect Function knows about a click beyond the slug arrives
// on the query string, which means none of it can be trusted: the URL is
// visitor-controlled, and an analytics dimension built from an unchecked query
// parameter is an unbounded-cardinality (and unbounded-length) field in the
// reporting pipeline. So every value is validated to a shape here, and anything
// that fails validation is dropped rather than reported.
//
// The click id is the exception that is *minted* rather than dropped: every
// outbound click gets one, because it is what threads through the affiliate
// network's sub-id slot and joins a network-reported sale back to the click.
// The client normally supplies it (so its own `Affiliate Link Clicked` row and
// this one share a key); a /go link followed without it — an article link, a
// bookmark, a crawler — still gets a fresh one.
//
// The parameter names are the ones src/lib/outbound.ts writes. They are
// restated rather than imported because that module is TypeScript and this one
// is loaded by the Workers runtime; src/lib/outbound.test.ts asserts the two
// agree.

/** Per-click join key. */
export const CLICK_ID_PARAM = 'cid';
/** The client analytics session's trace id. */
export const TRACE_ID_PARAM = 'tid';
/** Where on the page the link was clicked. */
export const PLACEMENT_PARAM = 'placement';
/** The card's zero-based slot in its list. */
export const POSITION_PARAM = 'position';

/** A UUID's alphabet and length — the shape mintClickId produces. */
const CLICK_ID_RE = /^[A-Za-z0-9-]{1,36}$/;

/** The SDK's trace id is its session UUID with the dashes stripped. */
const TRACE_ID_RE = /^[a-f0-9]{16,64}$/i;

/** Enumerated placement slugs ('deal-detail', 'promo-card', …). */
const PLACEMENT_RE = /^[a-z0-9-]{1,32}$/;

/**
 * A reportable slot index: digits only, so an absent parameter cannot read as
 * position 0, and at most three of them — deeper than that is not a dimension
 * anyone groups by.
 */
const POSITION_RE = /^\d{1,3}$/;

/**
 * A random UUID v4, used both as a click id and as the idempotency key of a
 * server-side event.
 *
 * `crypto.randomUUID` is always available in the Workers runtime; the fallbacks
 * exist so this module is testable under a bare node runner and so a click is
 * never dropped for want of an id.
 */
export function mintClickId(source = globalThis.crypto) {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
  } catch {
    /* randomUUID present but refused — fall through */
  }
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    if (typeof source?.getRandomValues === 'function') {
      source.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    /* getRandomValues refused — fall through to the non-crypto source */
  }
  if (!filled) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function matching(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/**
 * Read the click context off a /go URL.
 *
 * @param {URL} url            the request URL
 * @param {() => string} mint  click-id source, injectable for tests
 * @returns {{clickId: string, traceId?: string, placement?: string, position?: number}}
 */
export function readClickContext(url, mint = mintClickId) {
  const params = url.searchParams;
  const supplied = matching(params.get(CLICK_ID_PARAM), CLICK_ID_RE);
  const position = matching(params.get(POSITION_PARAM), POSITION_RE);
  return {
    clickId: supplied ?? mint(),
    traceId: matching(params.get(TRACE_ID_PARAM), TRACE_ID_RE),
    placement: matching(params.get(PLACEMENT_PARAM), PLACEMENT_RE),
    position: position === undefined ? undefined : Number(position),
  };
}
