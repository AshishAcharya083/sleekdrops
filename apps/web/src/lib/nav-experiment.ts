/**
 * Nav-item experiments - the decision layer behind `data-experiment-nav-item`.
 *
 * A nav item tagged with a feature key renders in the server HTML for every
 * visitor and is taken out of the nav client-side once the flag payload says so
 * (see `src/scripts/chrome.ts`). Two properties make that safe to run on a
 * live nav, and both live here rather than in the caller so they can be tested:
 *
 *  1. **Reversible and idempotent.** The payload is re-read (streaming plus the
 *     60s poll), so a value flipping back to false has to put the item back in
 *     the slot it rendered in, and a callback that fires again with an unchanged
 *     value must do nothing at all.
 *  2. **Only bucket who can see it.** Below the nav's breakpoint `.site-nav` is
 *     `display: none` and there is no mobile drawer, so a visitor there cannot
 *     receive the treatment. Reading the flag is what buckets them and fires
 *     `$experiment_viewed`, so the read itself is gated on the nav being on
 *     screen rather than the removal being gated on it.
 *
 * This module touches no globals and never reads a flag itself: the caller
 * passes the current viewport state and the reader, which keeps GrowthBook
 * behind the `./experiments` chokepoint.
 */

/** Attribute naming the feature key that governs a nav item's presence. */
export const NAV_ITEM_ATTRIBUTE = 'data-experiment-nav-item';

/**
 * Complement of the `@media (max-width: 900px) { .site-nav { display: none } }`
 * rule in `Header.astro`: when this matches, the primary nav is hidden. Kept as
 * the same literal breakpoint so the two cannot drift into a range where the nav
 * is hidden but the visitor is bucketed anyway.
 */
export const NAV_HIDDEN_QUERY = '(max-width: 900px)';

/** A nav item under experiment, captured before anything has been removed. */
export interface NavExperimentItem {
  /** The feature key read from `data-experiment-nav-item`. */
  readonly feature: string;
  readonly item: Element;
  readonly nav: Element;
  /** Everything that rendered after it, in order - empty when it rendered last. */
  readonly following: readonly Element[];
}

/**
 * Record where each tagged item sits in the server-rendered nav. Items with no
 * feature key or no parent nav are skipped rather than half-tracked.
 */
export function captureNavExperimentItems(items: Iterable<Element>): NavExperimentItem[] {
  const captured: NavExperimentItem[] = [];
  for (const item of items) {
    const feature = item.getAttribute(NAV_ITEM_ATTRIBUTE) ?? '';
    const nav = item.parentElement;
    if (!feature || !nav) continue;
    const following: Element[] = [];
    for (let next = item.nextElementSibling; next; next = next.nextElementSibling) {
      following.push(next);
    }
    captured.push({ feature, item, nav, following });
  }
  return captured;
}

/**
 * Bring one item in line with its flag value. Removal takes the item out of the
 * DOM - not merely out of view - so it leaves the accessibility tree and the tab
 * order with it, and the remaining items reflow on the nav's own gap.
 */
function setNavItemRemoved(entry: NavExperimentItem, removed: boolean): void {
  const isInNav = entry.item.parentElement === entry.nav;
  if (removed) {
    if (isInNav) entry.item.remove();
    return;
  }
  if (isInNav) return;
  // Back in front of the first item that followed it and is still in the nav,
  // which is its original slot however many of its neighbours another flag has
  // taken out in the meantime. Nothing left to anchor to means it rendered last.
  const before = entry.following.find((sibling) => sibling.parentElement === entry.nav) ?? null;
  entry.nav.insertBefore(entry.item, before);
}

/**
 * Apply the current flag values to every captured item. `readFlag` is called
 * only when the nav is actually displayed, so a visitor who never sees it is
 * never bucketed into the experiment.
 */
export function applyNavExperimentItems(
  entries: readonly NavExperimentItem[],
  navHidden: boolean,
  readFlag: (feature: string) => boolean,
): void {
  if (navHidden) return;
  for (const entry of entries) setNavItemRemoved(entry, readFlag(entry.feature));
}
