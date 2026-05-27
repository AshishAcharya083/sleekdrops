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

export const dailyDeals: Deal[] = [
  {
    id: 'airpods-pro-2',
    slug: 'apple-airpods-pro-2',
    brand: 'Apple',
    brandMark: 'A',
    title: 'AirPods Pro 2 — back to lowest tracked price.',
    description:
      'Apple drops AirPods Pro 2 to the lowest price we’ve tracked outside of Black Friday. No code needed; the discount applies at checkout.',
    priceNow: '$199',
    priceWas: '$229',
    discountLabel: '12% off',
    ends: 'Ends Sunday · No code needed',
    expiresAt: '2026-06-01',
    href: 'https://example.com/deals/airpods-pro-2',
    category: 'tech',
  },
  {
    id: 'dyson-v15',
    slug: 'dyson-v15-detect',
    brand: 'Dyson',
    brandMark: 'D',
    title: 'V15 Detect cordless — the only sub-$500 in months.',
    description:
      'Dyson lists the V15 Detect at $549 with promo code DROP15. First time it’s dipped under $500 since launch.',
    priceNow: '$549',
    priceWas: '$699',
    discountLabel: '$150 off',
    ends: 'Ends Nov 19 · Code DROP15',
    expiresAt: '2026-06-03',
    href: 'https://example.com/deals/dyson-v15',
    category: 'home',
    code: 'DROP15',
  },
  {
    id: 'fellow-stagg-ekg',
    slug: 'fellow-stagg-ekg',
    brand: 'Fellow',
    brandMark: 'F',
    title: 'Stagg EKG kettle — rare full-line discount.',
    description:
      'Fellow takes 20% off the full Stagg EKG line — variable temperature, gooseneck, the works. Site-wide, no code required.',
    priceNow: '$135',
    priceWas: '$169',
    discountLabel: '20% off',
    ends: 'Ends Nov 16 · Site-wide',
    expiresAt: '2026-06-02',
    href: 'https://example.com/deals/fellow-stagg-ekg',
    category: 'home',
  },
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
    ends: 'Ends Fri, Nov 17',
    expiresAt: '2026-06-05',
    href: 'https://example.com/deals/bose-qc-ultra',
    category: 'tech',
    featured: true,
  },
  {
    id: 'kindle-scribe',
    slug: 'kindle-scribe-deal',
    brand: 'Amazon',
    brandMark: 'A',
    title: 'Kindle Scribe (32 GB) — first hardware drop of the season.',
    description:
      'The 32 GB Kindle Scribe sees its first meaningful discount since launch. Comes with the premium pen, not the basic one.',
    priceNow: '$309',
    priceWas: '$369',
    discountLabel: '$60 off',
    ends: 'Ends Nov 21 · Prime members only',
    expiresAt: '2026-06-08',
    href: 'https://example.com/deals/kindle-scribe',
    category: 'tech',
  },
  {
    id: 'patagonia-overcoat',
    slug: 'patagonia-recycled-overcoat',
    brand: 'Patagonia',
    brandMark: 'P',
    title: 'Recycled wool overcoat — last full-price markdown of the year.',
    description:
      'Patagonia’s recycled-wool overcoat lands at $239. The 80% wool blend that passes our pilling test stays in stock at most sizes.',
    priceNow: '$239',
    priceWas: '$299',
    discountLabel: '20% off',
    ends: 'Ends Sunday · Most sizes in stock',
    expiresAt: '2026-06-09',
    href: 'https://example.com/deals/patagonia-overcoat',
    category: 'fashion',
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
