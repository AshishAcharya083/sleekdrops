// Affiliate redirect resolver — pure logic, no I/O.
//
// One place decides where /go/<slug> sends a visitor. Two axes:
//   1. REGION   — derived from the visitor's country (Cloudflare cf.country).
//   2. NETWORK  — how the final tracked URL is built (Amazon, Awin, …).
//
// The golden rule: credentials (Amazon tags, publisher/affiliate IDs) live
// HERE, derived per region/network — never hand-typed into each link. A link
// row only carries what's product-specific (an ASIN, a destination URL).
//
// Adding a region  = one line in COUNTRY_TO_REGION + one entry per network map.
// Adding a network = one builder in NETWORKS.
// Existing rows with no `network` field keep working via the `direct` builder.
//
// The third axis is the CLICK ID. Every outbound click carries one (minted by
// the browser, or by the Function for a link followed without it), and each
// network exposes exactly one slot for it: Amazon `ascsubtag`, Awin `clickref`,
// Commission Factory `UniqueId`. Threading it through is what makes a sale
// reported by the network 24-72 hours later joinable back to the deal, page,
// placement and position that earned the click — the publisher owns nothing
// after the redirect, so this parameter is the only thread back. Networks with
// no such slot, and rows falling back to `direct`, resolve exactly as before.

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

// ISO-3166-1 alpha-2 country (request.cf.country) → region key.
// Anything not listed falls back to DEFAULT_REGION.
export const COUNTRY_TO_REGION = {
  US: 'us',
  AU: 'au',
  NZ: 'au', // no NZ Amazon storefront; AU ships to NZ
  // Add more as you onboard storefronts/tags below, e.g.:
  // GB: 'uk', IE: 'uk', CA: 'ca',
};

export const DEFAULT_REGION = 'us';

// Per-region Amazon storefront + Associates tag. Tags are PER MARKETPLACE —
// amazon.com and amazon.com.au need different tags. Only real, owned tags here.
export const AMAZON = {
  us: { host: 'www.amazon.com', tag: 'sleekdrops-20' },
  au: { host: 'www.amazon.com.au', tag: 'sleekdrops-22' },
  // uk: { host: 'www.amazon.co.uk', tag: '<your-uk-tag>' },
  // ca: { host: 'www.amazon.ca',    tag: '<your-ca-tag>' },
};

// Network-global publisher/affiliate IDs (public, not secret — they appear in
// the outbound URL anyway). Fill these when you onboard the network; until
// then the builder returns null and the link falls back to entry.default.
export const AWIN_AFFID = ''; // your Awin publisher id (awinaffid)
export const CF_PUBLISHER_ID = ''; // your Commission Factory publisher id

// ---------------------------------------------------------------------------
// Network builders: (entry, region, clickId) -> absolute URL | null
// Return null when the row/config can't produce a valid URL; resolve() then
// falls back to entry.default so a click is never dropped.
// ---------------------------------------------------------------------------

/**
 * `&<param>=<clickId>`, or nothing at all when there is no click id — a network
 * that receives an empty sub-id reports it as an empty sub-id rather than as an
 * absent one, which is a row nothing can be joined to.
 */
function subId(param, clickId) {
  return clickId ? `&${param}=${encodeURIComponent(clickId)}` : '';
}

/**
 * Awin's cread.php tracking URL, or null when the row or the configuration
 * can't produce one.
 *
 * The publisher id is a parameter rather than read from the constant above so
 * this stays a pure function of its inputs: the constant is empty until the
 * network is onboarded, which would otherwise leave the `clickref` threading
 * untestable right up to the day it starts earning money.
 */
export function awinUrl(affiliateId, merchant, dest, clickId) {
  if (!affiliateId || !merchant || !dest) return null;
  return (
    `https://www.awin1.com/cread.php?awinmid=${merchant}` +
    `&awinaffid=${affiliateId}${subId('clickref', clickId)}` +
    `&ued=${encodeURIComponent(dest)}`
  );
}

/** Commission Factory's t.cfjump.com tracking URL. Pure, for the same reason. */
export function cfjumpUrl(publisherId, merchant, dest, clickId) {
  if (!publisherId || !merchant || !dest) return null;
  return (
    `https://t.cfjump.com/${publisherId}/t/${merchant}` +
    `?Url=${encodeURIComponent(dest)}${subId('UniqueId', clickId)}`
  );
}

export const NETWORKS = {
  // Amazon: storefront + tag come from the region; the row carries per-region
  // ASINs and a search term. ASINs are marketplace-specific — an ASIN captured
  // on amazon.com.au routinely 404s on amazon.com — so an ASIN is only used
  // for the region it was captured on; every other region gets a search-results
  // link, which always renders.
  // Row shape: { network:'amazon', search:'ninja blast portable blender',
  //              asins?:{ au:'B0..', us:'B0..' } }
  amazon(entry, region, clickId) {
    const market = AMAZON[region] ?? AMAZON[DEFAULT_REGION];
    if (!market) return null;
    const tracking = `tag=${market.tag}${subId('ascsubtag', clickId)}`;
    const asin = entry.asins && entry.asins[region];
    if (asin) return `https://${market.host}/dp/${asin}?${tracking}`;
    if (entry.search) {
      return `https://${market.host}/s?k=${encodeURIComponent(entry.search)}&${tracking}`;
    }
    return null;
  },

  // Awin: wrap a destination URL with the merchant id + your publisher id.
  // Row shape: { network:'awin', merchant:1234, url:'https://merchant.com/p' }
  awin(entry, region, clickId) {
    return awinUrl(AWIN_AFFID, entry.merchant, entry.url ?? entry.dest, clickId);
  },

  // Commission Factory: t.cfjump.com tracking link, ?Url= deep-links it.
  // Row shape: { network:'commissionfactory', merchant:1027, url:'https://...' }
  commissionfactory(entry, region, clickId) {
    return cfjumpUrl(CF_PUBLISHER_ID, entry.merchant, entry.url ?? entry.dest, clickId);
  },

  // Direct / legacy: per-region literal URL if present, else the default.
  // Handles every pre-existing affiliate_links row (no `network` field).
  // Row shape: { default:'https://...', au?:'https://...', us?:'https://...' }
  direct(entry, region) {
    return entry[region] ?? entry.default ?? null;
  },
};

// ---------------------------------------------------------------------------

export function regionFor(country) {
  return COUNTRY_TO_REGION[country] ?? DEFAULT_REGION;
}

/**
 * The builder a row resolves through — reported as the `network` dimension, and
 * the lookup resolve() uses.
 *
 * `Object.hasOwn` rather than `in`: `in` walks the prototype chain, so a row
 * whose `network` reads `constructor` or `toString` would select a function off
 * Object.prototype as its "builder". `NETWORKS.constructor(entry, …)` returns
 * the entry object itself, which is truthy, so resolve() would hand that object
 * back as a destination and the redirect would send visitors to
 * `[object Object]`.
 */
export function networkFor(entry) {
  return entry && typeof entry === 'object' && Object.hasOwn(NETWORKS, entry.network)
    ? entry.network
    : 'direct';
}

/**
 * Resolve the destination URL for a link row and visitor country.
 * @param {object|undefined} entry  affiliate_links row (merged frontmatter shape)
 * @param {string|undefined} country ISO alpha-2 (request.cf.country)
 * @param {string|undefined} clickId per-click join key, threaded into the
 *   network's sub-id slot. Omitted for a row whose network has no such slot.
 * @returns {string|null} absolute URL, or null if the slug is unknown
 */
export function resolve(entry, country, clickId) {
  if (!entry || typeof entry !== 'object') return null;
  const region = regionFor(country);
  const builder = NETWORKS[networkFor(entry)];
  // Builder first; if it can't build (missing asin/credentials), never drop the
  // click — fall back to the literal default, then to a region literal. The
  // fallbacks are untagged literals from the row, so they carry no sub-id and
  // resolve exactly as they always have.
  return builder(entry, region, clickId) ?? entry.default ?? NETWORKS.direct(entry, region);
}
