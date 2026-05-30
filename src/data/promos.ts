/**
 * Promo codes — discount codes from retailers we trust.
 *
 * Same shape as deals but typically longer-running, code-based, and not
 * tied to a single product. Lives as static data; swap for a feed later.
 */

import type { CategorySlug } from './categories-types';

export interface Promo {
  id: string;
  slug: string;
  brand: string;
  brandMark: string;
  title: string;
  description: string;
  /** The code the reader types at checkout. */
  code: string;
  /** Pre-formatted discount label, e.g. "15% off your first order". */
  discountLabel: string;
  /** Human-readable terms summary. */
  terms: string;
  /** Pre-formatted expiry, e.g. "Ends Dec 31". */
  ends: string;
  /** ISO date for sitemap / JSON-LD. */
  expiresAt: string;
  href: string;
  category: CategorySlug;
}

// EXAMPLE PROMO — one kept as a template. `href` is a /go/<slug> path so the
// affiliate destination lives in src/data/affiliate-links.json.
export const promos: Promo[] = [
  {
    id: 'bose-bundle',
    slug: 'bose-headphones-bundle',
    brand: 'Bose',
    brandMark: 'B',
    title: 'Bose — bundle the QC Ultra Headphones with the QC Earbuds.',
    description:
      'Buy the QC Ultra Headphones and the QC Ultra Earbuds together and Bose drops $80 off the combined price.',
    code: 'QC80',
    discountLabel: '$80 off · Bundle',
    terms: 'Both items must be in the same order. Excludes refurbished.',
    ends: 'Ends Dec 15',
    expiresAt: '2026-12-31',
    href: '/go/bose-headphones-bundle',
    category: 'tech',
  },
];

export function getPromoBySlug(slug: string): Promo | undefined {
  return promos.find((p) => p.slug === slug);
}

export function getActivePromos(): Promo[] {
  return promos.filter((p) => new Date(p.expiresAt).getTime() >= Date.now());
}
