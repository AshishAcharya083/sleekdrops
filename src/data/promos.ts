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

export const promos: Promo[] = [
  {
    id: 'fellow-newcomer',
    slug: 'fellow-newcomer-15',
    brand: 'Fellow',
    brandMark: 'F',
    title: 'Fellow — 15% off your first order.',
    description:
      'Welcome promo for first-time Fellow customers. Stacks with the Stagg EKG site-wide sale through the end of November.',
    code: 'WELCOME15',
    discountLabel: '15% off · First order',
    terms: 'New customers only. One use per household.',
    ends: 'Ends Dec 31',
    expiresAt: '2026-06-20',
    href: 'https://example.com/promo/fellow-welcome',
    category: 'home',
  },
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
    expiresAt: '2026-06-15',
    href: 'https://example.com/promo/bose-bundle',
    category: 'tech',
  },
  {
    id: 'patagonia-membership',
    slug: 'patagonia-member-10',
    brand: 'Patagonia',
    brandMark: 'P',
    title: 'Patagonia — 10% off when you sign in to your account.',
    description:
      'Stacks with the recycled-wool overcoat deal. Free shipping over $99, which the overcoat clears on its own.',
    code: 'MEMBER10',
    discountLabel: '10% off',
    terms: 'Account sign-in required. Excludes Worn Wear.',
    ends: 'Ongoing',
    expiresAt: '2026-12-31',
    href: 'https://example.com/promo/patagonia-member',
    category: 'fashion',
  },
];

export function getPromoBySlug(slug: string): Promo | undefined {
  return promos.find((p) => p.slug === slug);
}

export function getActivePromos(): Promo[] {
  return promos.filter((p) => new Date(p.expiresAt).getTime() >= Date.now());
}
