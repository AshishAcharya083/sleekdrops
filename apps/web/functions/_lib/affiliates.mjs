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
// Network builders: (entry, region) -> absolute URL | null
// Return null when the row/config can't produce a valid URL; resolve() then
// falls back to entry.default so a click is never dropped.
// ---------------------------------------------------------------------------

export const NETWORKS = {
  // Amazon: storefront + tag come from the region; the row carries per-region
  // ASINs and a search term. ASINs are marketplace-specific — an ASIN captured
  // on amazon.com.au routinely 404s on amazon.com — so an ASIN is only used
  // for the region it was captured on; every other region gets a search-results
  // link, which always renders.
  // Row shape: { network:'amazon', search:'ninja blast portable blender',
  //              asins?:{ au:'B0..', us:'B0..' } }
  amazon(entry, region) {
    const market = AMAZON[region] ?? AMAZON[DEFAULT_REGION];
    if (!market) return null;
    const asin = entry.asins && entry.asins[region];
    if (asin) return `https://${market.host}/dp/${asin}?tag=${market.tag}`;
    if (entry.search) {
      return `https://${market.host}/s?k=${encodeURIComponent(entry.search)}&tag=${market.tag}`;
    }
    return null;
  },

  // Awin: wrap a destination URL with the merchant id + your publisher id.
  // Row shape: { network:'awin', merchant:1234, url:'https://merchant.com/p' }
  awin(entry) {
    const dest = entry.url ?? entry.dest;
    if (!AWIN_AFFID || !entry.merchant || !dest) return null;
    return (
      `https://www.awin1.com/cread.php?awinmid=${entry.merchant}` +
      `&awinaffid=${AWIN_AFFID}&ued=${encodeURIComponent(dest)}`
    );
  },

  // Commission Factory: t.cfjump.com tracking link, ?Url= deep-links it.
  // Row shape: { network:'commissionfactory', merchant:1027, url:'https://...' }
  commissionfactory(entry) {
    const dest = entry.url ?? entry.dest;
    if (!CF_PUBLISHER_ID || !entry.merchant || !dest) return null;
    return (
      `https://t.cfjump.com/${CF_PUBLISHER_ID}/t/${entry.merchant}` +
      `?Url=${encodeURIComponent(dest)}`
    );
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
 * Resolve the destination URL for a link row and visitor country.
 * @param {object|undefined} entry  affiliate_links row (merged frontmatter shape)
 * @param {string|undefined} country ISO alpha-2 (request.cf.country)
 * @returns {string|null} absolute URL, or null if the slug is unknown
 */
export function resolve(entry, country) {
  if (!entry || typeof entry !== 'object') return null;
  const region = regionFor(country);
  const builder = NETWORKS[entry.network] ?? NETWORKS.direct;
  // Builder first; if it can't build (missing asin/credentials), never drop the
  // click — fall back to the literal default, then to a region literal.
  return builder(entry, region) ?? entry.default ?? NETWORKS.direct(entry, region);
}
