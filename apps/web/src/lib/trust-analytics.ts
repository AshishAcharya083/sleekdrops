/**
 * Analytics for the trust surfaces: whether readers open the methodology page,
 * expand the score explainer beside a review's rating, and follow a deal
 * badge's proof link.
 *
 * The components that render those surfaces emit only plain DOM hooks - the
 * page-view `screen`, `data-score-explainer` on the explainer's `<details>`,
 * `data-trust-badge="<kind>"` on a badge's proof link, each with optional JSON
 * props - and never reference an event name. chrome.ts hands the document to
 * `wireTrustAnalytics`, which turns those hooks into events. A page without a
 * hook fires nothing and logs nothing, so a surface that has not shipped yet is
 * simply quiet. See docs/analytics-events.md for the payloads.
 *
 * Kept out of chrome.ts so the dispatch rules are testable under the bare
 * `node --test` runner: this module never imports the analytics wrapper (which
 * pulls in the SDK), and takes `track` and `warn` from its caller instead.
 *
 * It never statically imports ./trust.ts either. That module carries the zod
 * schemas badges are validated with, and chrome.ts ships on every page, so a
 * static import roughly doubled every page's script. The badge kinds are
 * mirrored below in a map the compiler holds to the registry's own key type,
 * and the method version is loaded on the one page that reports it.
 */

import type { BadgeKind } from './trust.ts';
import type { EventProps } from './pii.ts';

/** The page-view `screen` the methodology page declares on BaseLayout. */
export const METHODOLOGY_SCREEN = 'how-we-rate';

/** The `EVENTS` keys this module reports under; chrome.ts maps them to names. */
export type TrustEvent = 'methodologyViewed' | 'scoreExplainerExpanded' | 'trustBadgeClicked';

export interface TrustAnalyticsDeps {
  /** The page-view `screen`, when the page declares one. */
  screenName: string | undefined;
  /** chrome.ts's hook-props parser: undefined for absent or malformed JSON. */
  parseProps: (raw: string | undefined) => EventProps | undefined;
  track: (event: TrustEvent, props?: EventProps) => void;
  warn: (message: string) => void;
}

/**
 * Every key of `badgeRegistry`. Typed as a record over `BadgeKind` so a kind
 * added to or removed from the registry fails the type check until it is
 * mirrored here; trust-analytics.test.ts checks the keys at runtime too.
 */
const REGISTRY_KINDS: Record<BadgeKind, true> = {
  'review-score': true,
  'lowest-price': true,
  'below-average': true,
  'skip-for-now': true,
};

/** True when `value` names a kind in the badge registry. */
export function isBadgeKind(value: string | undefined): value is BadgeKind {
  return value !== undefined && Object.hasOwn(REGISTRY_KINDS, value);
}

/**
 * Wires the trust hooks under `root`. The returned promise settles once the
 * methodology view, when this page reports one, has been dispatched; nothing
 * else waits on it.
 */
export async function wireTrustAnalytics(root: ParentNode, deps: TrustAnalyticsDeps): Promise<void> {
  const { screenName, parseProps, track, warn } = deps;

  /* `toggle` does not bubble, so each explainer gets its own listener. Only the
     first opening on a page load counts: re-opening the same explainer is one
     reader's continued interest, not a second reader. */
  root.querySelectorAll<HTMLDetailsElement>('details[data-score-explainer]').forEach((el) => {
    let reported = false;
    el.addEventListener('toggle', () => {
      if (!el.open || reported) return;
      reported = true;
      track('scoreExplainerExpanded', parseProps(el.dataset.scoreExplainerProps));
    });
  });

  /* The kind arrives as a runtime string, so it is checked against the registry
     the same way chrome.ts checks a `data-track` name: an unknown kind is a
     rendering bug, dropped and reported rather than sent. The attribute's kind
     wins over any `badge_kind` in the props. */
  root.querySelectorAll<HTMLElement>('[data-trust-badge]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = el.dataset.trustBadge;
      if (!isBadgeKind(kind)) {
        warn(`data-trust-badge kind is not in the badge registry, dropped: ${kind}`);
        return;
      }
      track('trustBadgeClicked', { ...parseProps(el.dataset.trustBadgeProps), badge_kind: kind });
    });
  });

  if (screenName === METHODOLOGY_SCREEN) {
    /* The view happened whether or not the chunk arrives (a stale deploy can
       404 it), so a failed load still counts the view, without the version. */
    const version = await import('./trust.ts').then(
      (trust) => trust.CURRENT_METHOD_VERSION,
      () => {
        warn('could not load the trust module; Methodology Viewed sent without method_version');
        return undefined;
      },
    );
    track('methodologyViewed', version ? { method_version: version } : undefined);
  }
}
