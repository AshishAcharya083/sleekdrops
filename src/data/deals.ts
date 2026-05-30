/**
 * Daily deals — the "drops" surface.
 *
 * These are short-lived merchant promos, not editorial posts, so they
 * live as static data (not a content collection). When the merchant feed
 * is wired up, swap this for a fetch in a server endpoint and preserve
 * the same shape.
 */

import type { CategorySlug } from './categories-types';

export interface Deal {
  id: string;
  slug: string;
  brand: string;
  /** Single character used in the logo tile. */
  brandMark: string;
  title: string;
  /** One-paragraph blurb shown on the deal detail page. */
  description: string;
  priceNow: string;
  priceWas: string;
  /** Pre-formatted discount label, e.g. "12% off" or "$150 off". */
  discountLabel: string;
  /** Pre-formatted end date / promo descriptor. */
  ends: string;
  /** ISO date for sitemap and JSON-LD `validThrough`. */
  expiresAt: string;
  href: string;
  category: CategorySlug;
  /** Optional promo code shown in the description. */
  code?: string;
  /** Show in hero "today's drop" carousel. */
  featured?: boolean;
}

// EXAMPLE DEAL — one kept as a template. `href` is a /go/<slug> path so the
// affiliate destination lives in src/data/affiliate-links.json. Always set a
// real future `expiresAt`; stale deals drop out of the live list automatically.
export const dailyDeals: Deal[] = [
  {
    id: 'bose-qc-ultra',
    slug: 'bose-qc-ultra-headphones',
    brand: 'Bose',
    brandMark: 'B',
    title: 'Bose QC Ultra Headphones — lowest price this quarter.',
    description:
      'Bose drops the QC Ultra Headphones to $329 — the lowest price we’ve tracked this quarter. No code required at checkout.',
    priceNow: '$329',
    priceWas: '$429',
    discountLabel: 'Save 23%',
    ends: 'Ends Friday',
    expiresAt: '2026-12-31',
    href: '/go/bose-qc-ultra-headphones',
    category: 'tech',
    featured: true,
  },
];

export const todaysDrop: Deal =
  dailyDeals.find((deal) => deal.featured) ?? dailyDeals[0];

export function getDealBySlug(slug: string): Deal | undefined {
  return dailyDeals.find((d) => d.slug === slug);
}

export function getActiveDeals(): Deal[] {
  return dailyDeals.filter((d) => new Date(d.expiresAt).getTime() >= Date.now());
}
