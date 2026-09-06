// Amazon link hygiene — the deterministic layer between "a URL appeared in
// search evidence" and "we ship it as an affiliate destination".
//
// ASINs scraped from search snippets are the #1 source of dead links: stale
// listings, wrong-marketplace ASINs, model-refresh churn. Before an ASIN is
// published it gets a liveness probe; anything that provably 404s is dropped
// and the /go/ resolver falls back to a search-results URL, which always
// renders in every marketplace.
import { parseAmazonUrl, type AmazonRegion } from '../content/contract.js';

// A believable browser UA — Amazon serves bots a 503 interstitial, which we
// deliberately treat as "alive" (only an explicit 404/410 is proof of death).
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface VerifiedAsin {
  region: AmazonRegion;
  asin: string;
}

/**
 * Probe an Amazon product URL. Returns the parsed {region, asin} only when the
 * listing CONFIRMS alive (a 2xx page), null otherwise.
 *
 * Policy: a dead deep link (reader lands on Amazon's 404 dog page) costs far
 * more than a downgraded one (reader lands on search results for the product),
 * so anything unconfirmed — 404, bot-block 503 that persists through retries,
 * timeout — is treated as dead and the resolver serves the search link.
 */
export async function verifyAmazonProductUrl(url: string): Promise<VerifiedAsin | null> {
  const parsed = parseAmazonUrl(url);
  if (!parsed) return null;

  const canonical = `https://www.amazon.com${parsed.region === 'au' ? '.au' : ''}/dp/${parsed.asin}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2500 * attempt));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(canonical, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return parsed; // confirmed live listing
      if (res.status === 404 || res.status === 410) return null; // confirmed dead
      // 503/429/5xx: bot throttle — back off and retry.
    } catch {
      // Timeout / network flake — retry.
    }
  }
  return null; // never confirmed → ship the search link instead
}

/**
 * The search term the /go/ resolver uses when it has no region ASIN. Brand +
 * product name, de-duplicated (names often already start with the brand).
 */
export function productSearchTerm(product: { name: string; brand?: string | null }): string {
  const name = product.name.trim();
  const brand = (product.brand ?? '').trim();
  const term =
    brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  return term.replace(/\s+/g, ' ').slice(0, 100);
}
