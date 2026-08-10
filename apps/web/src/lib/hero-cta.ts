/**
 * Hero secondary-CTA resolution - the decision layer behind the outline button
 * in the homepage hero.
 *
 * The button used to be a hardcoded `href="#today"`, but `#today` is emitted by
 * `DropPanel` only while there is an active drop. With no drop the anchor had no
 * target, so the click scrolled nowhere and navigated nowhere: a control that
 * looks actionable and returns nothing. Resolving it here, from the same deal
 * state the panel renders from, makes the anchor variant impossible to ship
 * without its target.
 *
 * Pure and free of Astro/DOM so the three states can be asserted directly.
 */

/** The id `DropPanel` puts on the active-drop card, and the only in-page anchor the hero may use. */
export const DROP_PANEL_ID = 'today';

/** Deal state the hero reads, expressed as the two facts that decide the CTA. */
export interface HeroDealState {
  /** True when `DropPanel` renders the active-drop card (and therefore `#today`). */
  readonly hasActiveDrop: boolean;
  /** How many deals `/deals` would list - the archive the no-drop hero routes to. */
  readonly archivedDealCount: number;
}

/**
 * What to render in the hero's second slot.
 *
 * `anchor` scrolls to the drop panel on the same page; `link` navigates; `none`
 * renders no second button at all rather than a duplicate of the primary CTA.
 */
export type HeroSecondaryCta =
  | { readonly kind: 'anchor'; readonly href: string; readonly label: string }
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  | { readonly kind: 'none' };

/** Where the no-drop hero sends visitors when there is an archive to send them to. */
export const DEALS_ARCHIVE_HREF = '/deals';
const BROWSE_ARCHIVE_LABEL = 'Browse past drops';

export function resolveHeroSecondaryCta(state: HeroDealState): HeroSecondaryCta {
  if (state.hasActiveDrop) {
    return { kind: 'anchor', href: `#${DROP_PANEL_ID}`, label: "See today's drop" };
  }
  if (state.archivedDealCount > 0) {
    return { kind: 'link', href: DEALS_ARCHIVE_HREF, label: BROWSE_ARCHIVE_LABEL };
  }
  // Today's state: /deals has nothing to list, so it would answer this button
  // with its own empty state. A hero CTA is the page's strongest promise and
  // has to be worth the click; the no-drop panel makes the softer offer of the
  // archive instead, in the sentence that admits it may be empty.
  return { kind: 'none' };
}

/** The action button on `DropPanel`'s no-drop state. */
export interface DropPanelAction {
  readonly href: string;
  readonly label: string;
}

/**
 * The no-drop panel's route out, given the CTA the hero already resolved to.
 *
 * The panel carries the archive route only when the hero itself does not: two
 * buttons to `/deals` a hundred pixels apart are noise, not a second option.
 * With the hero CTA omitted - today's state - this is the visitor's one real
 * next step, which is exactly why the panel owns it rather than the hero.
 */
export function resolveDropPanelAction(cta: HeroSecondaryCta): DropPanelAction | undefined {
  if (cta.kind !== 'none') return undefined;
  return { href: DEALS_ARCHIVE_HREF, label: BROWSE_ARCHIVE_LABEL };
}
