/**
 * Product registry.
 *
 * A review post optionally links a product by id (frontmatter
 * `product: sonos-era-300`). The product provides structured
 * scoring data (rating, pros, cons, price, brand) used by the review
 * layout and the JSON-LD generator.
 */

import type { CategorySlug } from './categories-types';

export interface ProductOffer {
  retailer: string;
  /** Pre-formatted current price, e.g. "$799". */
  price: string;
  /** Pre-formatted list / original price, e.g. "$899". */
  priceWas?: string;
  /** Affiliate URL — always carries `rel="sponsored nofollow"` at render. */
  href: string;
  /** Optional badge ("Editor's choice", "Best value"). */
  badge?: string;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  brandMark: string;
  category: CategorySlug;
  /** 1-line tagline used in the Quick Verdict and product callout. */
  tagline: string;
  /** Honest decimal rating 1.0–5.0. */
  rating: number;
  pros: string[];
  cons: string[];
  /** Primary affiliate offer (used by the Quick Verdict box). */
  offer: ProductOffer;
  /** Optional spec table rows for the comparison table. */
  specs?: Record<string, string>;
}

// EXAMPLE PRODUCT — one kept as a template for `review` posts.
// A review post links it via frontmatter `product: sonos-era-300`.
// `offer.href` MUST be a /go/<slug> path so the affiliate destination lives
// in src/data/affiliate-links.json (the single source of truth), not here.
export const products: Record<string, Product> = {
  'sonos-era-300': {
    id: 'sonos-era-300',
    name: 'Sonos Era 300',
    brand: 'Sonos',
    brandMark: 'S',
    category: 'tech',
    tagline:
      'The Era 300 earns its premium for big rooms; the Era 100 stereo pair wins everywhere else.',
    rating: 4.0,
    pros: [
      'Spatial-audio Atmos mix is real in larger rooms',
      'Reach below 50 Hz is the widest in the Sonos lineup',
      'TruePlay tuning still the easiest in the category',
    ],
    cons: [
      'Atmos benefit flattens in rooms under 4 × 4 m',
      'Two Era 100s outperform one Era 300 for the same money',
    ],
    offer: {
      retailer: 'Sonos',
      price: '$449',
      href: '/go/sonos-era-300',
    },
  },
};

export function getProduct(id: string): Product | undefined {
  return products[id];
}
