/**
 * The figures the /about stats band prints, counted from the published posts
 * rather than typed into the page.
 *
 * A trust statistic is only worth printing if a reader could recount it from
 * the site. So every figure here is derived from frontmatter, and the average
 * score is returned with the number of reviews behind it, because an average
 * without its sample reads as a claim about quality rather than a description
 * of how we score.
 *
 * Explicit .ts extensions: loaded directly by the node --test runner.
 */

import type { ReviewUnitData } from '../content/frontmatter.ts';

/** The slice of a post's frontmatter these figures read. */
export interface StatsPost {
  product?: { rating: number };
  reviewUnit?: Pick<ReviewUnitData, 'acquisition'>;
  /** The assessment provenance, where the post records one. */
  provenance?: string;
}

export interface ScoreSummary {
  /** Reviews carrying a score. */
  scored: number;
  /** Mean score across them, to the one decimal place scores are given in. */
  average: number;
}

/** The average score given, or null when nothing published carries one. */
export function scoreSummary(posts: readonly StatsPost[]): ScoreSummary | null {
  const ratings = posts.flatMap((post) => (post.product ? [post.product.rating] : []));
  if (ratings.length === 0) return null;
  const mean = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return { scored: ratings.length, average: Math.round(mean * 10) / 10 };
}

/**
 * Posts whose product came from the brand: a loaned review unit, or a recorded
 * brand-sample provenance. Either one is a benefit the brand gave us.
 */
export function brandSuppliedCount(posts: readonly StatsPost[]): number {
  return posts.filter(
    (post) => post.reviewUnit?.acquisition === 'loan' || post.provenance === 'brand-sample',
  ).length;
}
