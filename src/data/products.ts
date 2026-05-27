/**
 * Product registry.
 *
 * A review post optionally links a product by id (frontmatter
 * `product: uplift-v2-commercial`). The product provides structured
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

export const products: Record<string, Product> = {
  'uplift-v2-commercial': {
    id: 'uplift-v2-commercial',
    name: 'Uplift V2 Commercial',
    brand: 'Uplift Desk',
    brandMark: 'U',
    category: 'home',
    tagline:
      "The Uplift V2 Commercial wins on stability — and on the parts you can't see.",
    rating: 4.3,
    pros: [
      'Dead-quiet dual motor (43 dB at 50 cm)',
      'Sub-2 mm wobble at full extension',
      'Seven-year warranty on every part',
      'Grommet placement is, surprisingly, perfect',
    ],
    cons: [
      'Heavy. Plan for two people on assembly',
      'The advanced controller costs $39 extra',
    ],
    offer: {
      retailer: 'Uplift',
      price: '$799',
      priceWas: '$899',
      href: 'https://example.com/buy/uplift-v2-commercial',
      badge: "Editor's choice",
    },
    specs: {
      'Frame stability': 'Excellent',
      'Motor noise': '43 dB',
      'Warranty': '7 years',
      'Anti-collision': 'Yes',
    },
  },
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
      href: 'https://example.com/buy/sonos-era-300',
    },
  },
  'fellow-stagg-ekg': {
    id: 'fellow-stagg-ekg',
    name: 'Fellow Stagg EKG',
    brand: 'Fellow',
    brandMark: 'F',
    category: 'home',
    tagline:
      'The Stagg EKG remains the kettle to beat: gooseneck spout, variable temperature, and the build to back it up.',
    rating: 4.5,
    pros: [
      'Most controllable pour in the category',
      'Variable temperature with a hold function',
      'Build feels twice the price',
    ],
    cons: [
      'Small capacity — 0.9 L',
      'Lid hinge feels stiff out of the box',
    ],
    offer: {
      retailer: 'Fellow',
      price: '$135',
      priceWas: '$169',
      href: 'https://example.com/buy/fellow-stagg-ekg',
      badge: 'Best in test',
    },
  },
};

export function getProduct(id: string): Product | undefined {
  return products[id];
}
