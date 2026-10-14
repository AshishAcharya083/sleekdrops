/**
 * Wide-table scroll affordance - whether a table is actually wider than the
 * column it sits in, and what to tell the reader when it is.
 *
 * A comparison table is the one block allowed the article column's full width
 * (see ArticleBody.astro), and wider than that column it scrolls inside itself
 * rather than taking the page sideways. That is the right behaviour and an
 * invisible one: on a phone the table is simply clipped mid-column, with
 * nothing to say the rest of it is a swipe away.
 *
 * The hint is shown against the table's measured overflow rather than a
 * breakpoint, because the width at which a table overflows is a property of the
 * table - a three-column table never needs the hint, a seven-column one needs it
 * well above phone widths. The measuring belongs to the DOM; the decision is
 * this pure rule, tested without one (the `./ad-placement` pattern).
 */

/**
 * Slack allowed before a table counts as overflowing, in CSS pixels.
 *
 * `scrollWidth` and `clientWidth` are rounded independently, so a table that
 * exactly fits its column can report one pixel more than it has. A hint under a
 * table with nothing to scroll to is worse than no hint at all.
 */
export const OVERFLOW_TOLERANCE = 1;

/** What the hint says. One line: it sits in the reading column, above the table. */
export const TABLE_SCROLL_HINT = 'Scroll sideways to see the rest of this table';

/**
 * Whether a horizontally scrollable box has content the reader cannot currently
 * see - `scrollWidth` and `clientWidth` as the element reports them.
 */
export function overflowsSideways(scrollWidth: number, clientWidth: number): boolean {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return false;
  return scrollWidth - clientWidth > OVERFLOW_TOLERANCE;
}
