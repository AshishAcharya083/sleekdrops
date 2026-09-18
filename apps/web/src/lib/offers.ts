/**
 * How an attached offer is presented to a reader.
 *
 * A product announced this week has no feed row behind it and cannot be read
 * through Amazon's Product Advertising API (that one is gated behind three
 * qualifying sales in 180 days), so its price is whatever a person last saw on
 * the merchant's page. Printing that as if it were live is the misstatement
 * the ACCC's "impression your presentation creates" standard is about, so the
 * page says what it actually knows: a recommended retail price, the day it was
 * seen, and a link to check what it costs right now.
 *
 * Staleness is recomputed here rather than trusted from the build that wrote
 * it. The flag on the record was true the day it was stamped; a site rebuilt a
 * fortnight later must not keep calling a fed price current because it was
 * current then.
 */
import type { PickOfferData } from '../content/frontmatter.ts';
import { formatLong } from './format.ts';

/** How long an automatically-sourced price stays presentable as current. */
export const STALE_PRICE_DAYS = 7;

export interface OfferPresentation {
  /** A pre-order is its own treatment: the reader is not charged yet. */
  preorder: boolean;
  /** True when the figure is quoted as a dated RRP rather than as live. */
  dated: boolean;
  /** "RRP A$2,899" or, for a live figure, "A$2,899". */
  priceLabel: string;
  /** "as at 18 September 2026", or null when the price is live. */
  stamp: string | null;
  /** The observed date as YYYY-MM-DD, for the <time datetime> attribute. */
  stampDate: string | null;
  /** "Ships 30 September 2026 — charged on dispatch", or null. */
  releaseNote: string | null;
  releaseDate: string | null;
  /** "Check current price at Amazon AU" where we know the merchant. */
  checkLabel: string;
}

function parseDay(iso: string): Date | null {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysSince(iso: string, today: Date): number | null {
  const day = parseDay(iso);
  if (!day) return null;
  return Math.floor((today.getTime() - day.getTime()) / 86_400_000);
}

/**
 * Whether the figure has to be shown as a dated RRP. Always for a price a
 * person typed (nothing is polling it), and for a fed one once its last
 * observation has aged out.
 */
export function offerIsDated(offer: PickOfferData, today: Date = new Date()): boolean {
  if (offer.stale || offer.source === 'editor') return true;
  const age = daysSince(offer.asAt, today);
  return age === null || age > STALE_PRICE_DAYS;
}

export function offerPresentation(
  offer: PickOfferData,
  today: Date = new Date(),
): OfferPresentation {
  const dated = offerIsDated(offer, today);
  const observed = parseDay(offer.asAt);
  const release = offer.releaseDate ? parseDay(offer.releaseDate) : null;
  return {
    preorder: offer.preorder === true,
    dated,
    priceLabel: dated ? `RRP ${offer.price}` : offer.price,
    stamp: dated && observed ? `as at ${formatLong(observed)}` : null,
    stampDate: dated && observed ? offer.asAt : null,
    releaseNote: release
      ? `Ships ${formatLong(release)} — you are charged on dispatch, not today`
      : offer.preorder
        ? 'Pre-order — you are charged on dispatch, not today'
        : null,
    releaseDate: release ? offer.releaseDate! : null,
    checkLabel: offer.merchant ? `Check current price at ${offer.merchant}` : 'Check current price',
  };
}
