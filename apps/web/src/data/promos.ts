/**
 * Promo codes — discount codes from retailers we trust.
 *
 * Same shape as deals but typically longer-running, code-based, and not
 * tied to a single product. Array starts empty; add real promos as they
 * happen. See deals.ts for the rationale on keeping these as TS code-as-data.
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

export const promos: Promo[] = [];

export function getPromoBySlug(slug: string): Promo | undefined {
  return promos.find((p) => p.slug === slug);
}

export function getActivePromos(): Promo[] {
  return promos.filter((p) => new Date(p.expiresAt).getTime() >= Date.now());
}
