/**
 * Where an in-page anchor click should scroll to - the geometry decision behind
 * the `a[href^="#"]` handler in `scripts/chrome.ts`.
 *
 * The handler has to tell two situations apart: a click that should move the
 * page, and a click that cannot move it because the target is already sitting
 * where the scroll would put it (the desktop hero, where the drop panel is
 * beside the CTA). Only the second one may be answered with a highlight alone.
 *
 * "Already visible" is not the same question. A heading half a screen down is
 * fully in the viewport and still a useful ~300px scroll away - answering that
 * click with a flash would leave article TOC links moving nothing, which is the
 * click-with-no-response this behaviour exists to remove. So the test is the
 * scroll distance itself.
 *
 * Pure and free of DOM so both branches can be asserted directly.
 */

/** Clearance for the fixed site header, which the scroll lands the target below. */
export const ANCHOR_SCROLL_OFFSET = 90;

/**
 * Scroll distance below which the page is treated as already landed. Covers
 * sub-pixel layout rounding, not a distance a visitor could perceive.
 */
export const ANCHOR_SCROLL_EPSILON = 4;

export interface AnchorScrollGeometry {
  /** Document-space offset of the target's top edge (`el.offsetTop`). */
  readonly targetTop: number;
  /** Current scroll position (`window.scrollY`). */
  readonly scrollY: number;
  /** Furthest the document can scroll - `scrollHeight - innerHeight`. */
  readonly maxScrollY: number;
}

/**
 * The scroll position that puts the target below the header, or `null` when the
 * page is already there and a scroll would move nothing.
 *
 * The destination is clamped to what the document can actually reach, so a
 * target near the end of the page - which the browser cannot lift any higher -
 * reports "already landed" instead of requesting a scroll that never happens.
 */
export function resolveAnchorScrollTop({
  targetTop,
  scrollY,
  maxScrollY,
}: AnchorScrollGeometry): number | null {
  const furthest = Math.max(maxScrollY, 0);
  const destination = Math.min(Math.max(targetTop - ANCHOR_SCROLL_OFFSET, 0), furthest);
  return Math.abs(destination - scrollY) < ANCHOR_SCROLL_EPSILON ? null : destination;
}
