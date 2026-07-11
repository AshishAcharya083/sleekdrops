/**
 * Daily deals — the "drops" surface.
 *
 * Real deal data is added by humans/agents to this file. The shape is fixed;
 * the array starts empty (the bose example shipped with v1 was removed when
 * editorial content moved into the sleekdrops-cms repo). Deals are intentionally
 * still TypeScript code-as-data here because the layout queries them at build
 * time and we want the type system to catch malformed entries before deploy.
 *
 * If you need to move deals to the CMS repo later, add a `data/deals.json`
 * there and have scripts/fetch-content.mjs copy it into .cms-cache/data/, then
 * re-export from this module.
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

export const dailyDeals: Deal[] = [];

export const todaysDrop: Deal | undefined =
  dailyDeals.find((deal) => deal.featured) ?? dailyDeals[0];

export function getDealBySlug(slug: string): Deal | undefined {
  return dailyDeals.find((d) => d.slug === slug);
}

export function getActiveDeals(): Deal[] {
  return dailyDeals.filter((d) => new Date(d.expiresAt).getTime() >= Date.now());
}
