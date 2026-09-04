/**
 * Listing telemetry - the payloads that make the deal and promo funnel
 * measurable end to end: list view, card click, detail view, click-out.
 *
 * Two rules the shapes here exist to enforce, both of which are easy to break
 * by hand at a call site and impossible to break through these functions:
 *
 *  1. **One list-view event per rendered list, never one per card.** Impressions
 *     are the highest-volume event on a deals site; a per-card event multiplies
 *     the volume by the page size and buys nothing the count on the list-view
 *     event does not already give. `listViewProps` is therefore built from the
 *     whole list, and the listing markup carries exactly one hook.
 *  2. **Every value is low-cardinality.** List ids and placements are closed
 *     unions, positions are non-negative integers, and nothing free-form gets
 *     in - which is also why pagination rides as `page`/`batch` properties here
 *     rather than as an event stream of its own.
 *
 * Pure and dependency-free (the `./consent` / `./pii` pattern), so the payload
 * rules are unit-tested without a DOM - see listing.test.ts.
 */

// Explicit .ts extension: this module is loaded directly by the node --test
// runner (see listing.test.ts), which needs a real specifier.
import type { EventProps } from './pii.ts';

/**
 * Every list that reports a view. Closed on purpose: `list_id` is the dimension
 * a click-through rate is grouped by, so a new surface has to be named here
 * (and documented) rather than invented at a call site.
 */
export const LIST_IDS = ['home-deals', 'deals-index', 'promos-index'] as const;

export type ListId = (typeof LIST_IDS)[number];

/**
 * Where a card sits in the page, as opposed to which list it belongs to. The
 * two are separate dimensions: `placement` is the kind of slot (and shares its
 * vocabulary with the affiliate-click placements `deal-detail`, `promo-detail`,
 * `drop-panel`, ...), `list_id` is the specific list instance.
 */
export const CARD_PLACEMENTS = ['deal-card', 'promo-card'] as const;

export type CardPlacement = (typeof CARD_PLACEMENTS)[number];

export interface ListViewInput {
  listId: ListId;
  /** How many cards this render actually put on the page. */
  count: number;
  /** 1-based listing page number. Unpaginated listings are page 1. */
  page?: number;
  /** 0-based index of the lazily-loaded batch. A single-shot render is batch 0. */
  batch?: number;
}

/** Clamp to a non-negative integer, so a bad caller cannot widen the dimension. */
function wholeNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** The `Listing Viewed` payload for one rendered list. */
export function listViewProps({ listId, count, page, batch }: ListViewInput): EventProps {
  return {
    list_id: listId,
    count: wholeNumber(count, 0),
    page: Math.max(1, wholeNumber(page, 1)),
    batch: wholeNumber(batch, 0),
  };
}

export interface CardClickInput {
  listId: ListId;
  slug: string;
  brand: string;
  placement: CardPlacement;
  /** The card's zero-based slot in the rendered list. */
  position: number;
}

/**
 * The payload for a click on one card of a list. It carries the same `list_id`
 * as that list's view event, which is the join that makes click-through rate
 * per card and per slot position computable.
 */
export function cardClickProps({
  listId,
  slug,
  brand,
  placement,
  position,
}: CardClickInput): EventProps {
  return {
    slug,
    brand,
    placement,
    position: wholeNumber(position, 0),
    list_id: listId,
  };
}
