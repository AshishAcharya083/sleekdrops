/**
 * Outbound affiliate clicks - the client half of the join between what the
 * browser reported and what the redirect actually served.
 *
 * The click a visitor makes on a `/go/<slug>` link is counted twice, on purpose
 * and under two different names. The client's `Affiliate Link Clicked` carries
 * the rich page context (screen, placement, list, position) but is lossy: ad
 * blockers drop the beacon and an unload race can cut it short. The Function's
 * `Affiliate Redirect Served` is the ad-block-proof count but knows only what
 * the URL told it. The click id minted here is what makes them one row: it goes
 * into the event's properties, onto the `/go` URL, and from there into the
 * affiliate network's sub-id slot, so a network-reported sale weeks later still
 * finds the deal, page, placement and position that earned it.
 *
 * The trace id rides along for the same reason in the other direction: a client
 * error and the server-side log of the click that preceded it are then findable
 * under one key.
 *
 * Pure and dependency-free, so the URL rules are unit-tested without a DOM (see
 * outbound.test.ts). The query-parameter names are restated - and guarded by a
 * test - in `functions/_lib/click.mjs`, which cannot import a `.ts` module.
 */

/** Per-click join key: `?cid=<click id>`. */
export const CLICK_ID_PARAM = 'cid';
/** The analytics session's trace id: `?tid=<trace id>`. */
export const TRACE_ID_PARAM = 'tid';
/** Where on the page the link was clicked: `?placement=deal-detail`. */
export const PLACEMENT_PARAM = 'placement';
/** The card's zero-based slot in its list: `?position=2`. */
export const POSITION_PARAM = 'position';

/**
 * Base for parsing relative hrefs. Never sent anywhere - a decorated
 * same-origin link is handed back as a path, exactly as it was written.
 */
const RELATIVE_BASE = 'https://sd.invalid';

/** The redirect route this site owns. Everything else is left untouched. */
const GO_PATH_RE = /^\/go\/[^/]+\/?$/;

function parse(href: string): URL | null {
  try {
    return new URL(href, RELATIVE_BASE);
  } catch {
    return null;
  }
}

/**
 * True when `href` points at this site's `/go/<slug>` redirect route.
 *
 * A type predicate, so a caller that has narrowed an attribute value with it
 * can pass the result straight to `decorateGoHref` without a cast.
 */
export function isGoLink(href: string | null | undefined): href is string {
  if (!href) return false;
  const url = parse(href);
  return url !== null && GO_PATH_RE.test(url.pathname);
}

export interface OutboundContext {
  /** The per-click join key. Required: an undecorated click cannot be joined. */
  clickId: string;
  /** This session's analytics trace id, when analytics is running. */
  traceId?: string;
  /** The enumerated placement the link was clicked from. */
  placement?: string;
  /** The card's zero-based slot, when the link sits in a list. */
  position?: number;
}

/**
 * Append the click context to a `/go` href, replacing any values already on it
 * so a second click on the same link mints a second, distinct click rather than
 * stacking parameters.
 *
 * Anything that is not a `/go` link - an external merchant URL written straight
 * into an article, an in-page anchor - is handed back untouched: this must never
 * rewrite a destination the site does not own.
 */
export function decorateGoHref(href: string, context: OutboundContext): string {
  if (!isGoLink(href) || !context.clickId) return href;
  const url = parse(href);
  if (!url) return href;
  const { traceId, placement, position } = context;
  url.searchParams.set(CLICK_ID_PARAM, context.clickId);
  if (traceId) url.searchParams.set(TRACE_ID_PARAM, traceId);
  if (placement) url.searchParams.set(PLACEMENT_PARAM, placement);
  if (position !== undefined && Number.isInteger(position) && position >= 0) {
    url.searchParams.set(POSITION_PARAM, String(position));
  }
  return url.origin === RELATIVE_BASE ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
