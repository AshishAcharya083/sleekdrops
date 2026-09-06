/**
 * Ad placement - where a unit belongs inside a body of content, and whether that
 * body is substantial enough to carry one at all.
 *
 * Split out of the components for the reason `./listing` is split out of the
 * listings: the rules are the part worth getting right and the part easiest to
 * break by hand, and they are decidable from a description of the content
 * without a DOM. `./ads` decides *whether* a visitor may be shown a unit; this
 * decides *where* one goes once they may.
 *
 * Two rules, and both are revenue rules as much as taste rules:
 *
 *  1. **Thin content carries no unit.** An ad wedged into a four-paragraph post
 *     is a worse page and a worse impression - it earns a low viewable CPM, it
 *     pushes the content-to-ads ratio the wrong way, and "little or no original
 *     content" alongside ads is the shape of an AdSense policy action. Below the
 *     thresholds here the unit is not rendered at all rather than rendered small.
 *  2. **A unit lands on a break in the content, not in the middle of a thought.**
 *     The mid-article slot goes to the first section heading at or after the
 *     halfway mark, so it reads as a break between sections rather than an
 *     interruption - and it is always genuinely mid-article, which is what
 *     separates it from the end-of-article slot below it.
 *
 * Pure and dependency-free (the `./consent` / `./pii` / `./listing` pattern), so
 * the rules are unit-tested without a DOM - see ad-placement.test.ts.
 */

/**
 * Top-level blocks an article must have before the mid-article unit is placed.
 *
 * Eight is roughly the point at which a post has a second section worth breaking
 * on; below it the mid and end units would land within a screen of each other,
 * which is two impressions competing for one reader rather than two placements.
 */
export const MIN_ARTICLE_BLOCKS = 8;

/**
 * Blocks that must sit above and below the unit. Above, so a reader has real
 * content before the first ad; below, so the "mid" unit cannot slide down into
 * the end-of-article unit's position.
 */
const ARTICLE_MARGIN = 2;

/** Cards a grid must hold before one of its slots is given to a unit. */
export const MIN_FEED_CARDS = 4;

/**
 * Cards shown before the in-feed unit - one full row of the three-column desktop
 * grid, so the unit opens the second row rather than interrupting the first.
 */
const FEED_INDEX = 3;

/**
 * The index of the top-level block the mid-article unit is inserted *before*, or
 * `null` when the article is too short to carry one.
 *
 * `blocks` is the article body's top-level children as lowercased tag names in
 * document order - everything this decision needs, and nothing that needs a DOM
 * to express.
 */
export function midArticleIndex(blocks: readonly string[]): number | null {
  if (blocks.length < MIN_ARTICLE_BLOCKS) return null;
  const first = ARTICLE_MARGIN;
  const last = blocks.length - ARTICLE_MARGIN;
  // Ceil, so an even-length body puts the unit at or past the true midpoint
  // rather than one block above it.
  const midpoint = Math.ceil(blocks.length / 2);
  const breaks = blocks
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag, index }) => tag === 'h2' && index >= first && index <= last);
  if (breaks.length > 0) {
    // The break *nearest* the midpoint, not the first one past it: a post whose
    // only back-half heading sits at three-quarters would otherwise put a
    // "mid-article" unit three-quarters down, well into the end unit's reader.
    // Ties keep the earlier block, which is the more viewable of the two.
    return breaks.reduce((best, candidate) =>
      Math.abs(candidate.index - midpoint) < Math.abs(best.index - midpoint) ? candidate : best,
    ).index;
  }
  // No usable section break at all - a single-section explainer, or a post
  // written as unbroken prose. The midpoint itself is still mid-article.
  return Math.min(Math.max(midpoint, first), last);
}

/**
 * The card index the in-feed unit is inserted *before*, or `null` when the grid
 * is too small to give a slot away.
 *
 * A unit in a three-card grid is a third of the page's inventory and reads as an
 * ad-first listing; below the threshold the grid stays whole.
 */
export function inFeedIndex(count: number): number | null {
  if (count < MIN_FEED_CARDS) return null;
  return Math.min(FEED_INDEX, count);
}
