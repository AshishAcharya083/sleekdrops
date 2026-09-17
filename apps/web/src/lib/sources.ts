/**
 * The reader's view of an article's evidence: the numbered sources block at
 * the foot of a piece, and the review stamp under its byline.
 *
 * Everything here is a pure transform of frontmatter the agent's assembler
 * wrote from the research dossier (apps/agent/src/content/sources.ts), so the
 * list a reader sees is the list the research actually produced - same order,
 * same numbering the body's citation markers use. Nothing is inferred: a
 * source with no date is shown as undated, and a source whose publisher we
 * could not confirm says exactly that.
 *
 * Two rules about the weak rows, which are the ones this surface lives or dies
 * on. They are never dropped and never re-sorted: a reader who follows a
 * citation marker to a row that is not there has caught us concealing, and
 * re-sorting would break the numbering the markers point at. And each one says
 * what it does *not* do ("does not count toward this guide's freshness")
 * rather than being labelled unreliable, which only invites the reader to ask
 * why we used it at all.
 *
 * Explicit .ts extensions: this module is loaded directly by the node --test
 * runner (see sources.test.ts), which needs real specifiers.
 */

import type { SourceData, SourceTier } from '../content/frontmatter.ts';

/**
 * What each tier means to a reader, in the reader's words. The weakest tier is
 * named for what is missing rather than for our internal verdict on it - the
 * reader can act on "publisher not identified", and cannot on "unplaced".
 */
export const TIER_LABELS: Record<SourceTier, string> = {
  primary: 'Maker or retailer',
  expert: 'Independent testing',
  owner: 'Owner reports',
  aggregator: 'Aggregated data',
  unknown: 'Publisher not identified',
};

/** The tiers that carry the most weight, strongest first - the order the methodology page documents. */
export const TIER_ORDER: SourceTier[] = ['expert', 'primary', 'owner', 'aggregator', 'unknown'];

/**
 * How long a piece may go between re-checks, by category.
 *
 * The commitment is published per category rather than per article, which is
 * what the Australian category leaders actually do - Canstar Blue re-runs a
 * ratings category about every 12 months, and a CHOICE Recommended licence
 * runs 6 or 12 months depending on how fast the category moves. Ours splits
 * the same way: twice as often where a recommendation turns on a price, a rate
 * or a model that is superseded within the year.
 */
export const REVIEW_INTERVAL_DAYS = 365;

/** The cadence for the categories whose evidence goes stale within the year. */
export const FAST_REVIEW_INTERVAL_DAYS = 183;

/** The categories on the shorter cadence, and why each one is on it. */
export const FAST_MOVING_CATEGORIES: Record<string, string> = {
  Tech: 'models are superseded mid-year and prices move with each release',
  Finance: 'rates, fees and product terms change between reviews',
  Travel: 'fares, routes and inclusions are repriced constantly',
};

/** How often this category's articles are re-checked, in days. */
export function reviewIntervalDays(category?: string): number {
  return category && Object.hasOwn(FAST_MOVING_CATEGORIES, category)
    ? FAST_REVIEW_INTERVAL_DAYS
    : REVIEW_INTERVAL_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The three shapes a source date may take, as the frontmatter schema allows them. */
const SOURCE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** One rendered row of the sources block. */
export interface SourceEntry {
  /** 1-based, and the number the body's citation markers point at. */
  index: number;
  url: string;
  /** Resolved publisher - never blank, because a row with no attribution is not evidence. */
  publisher: string;
  tier: SourceTier | null;
  tierLabel: string | null;
  /** The source's own date, at the precision it published one. Null when undated. */
  dateLabel: string | null;
  /** The URL as a reader reads it: no scheme, no `www.`, no trailing slash. */
  linkLabel: string;
  /** What is missing from this row, said plainly. Null when nothing is. */
  caution: string | null;
}

/** The URL a reader sees under a source: the address, minus the noise. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * A source date as the source published it: to the day, to the month, or to
 * the year. Parsed as UTC so a date never slides a day backwards for a reader
 * west of Greenwich.
 */
export function formatSourceDate(date: string | undefined): string | null {
  if (!date || !SOURCE_DATE.test(date)) return null;
  const [year, month, day] = date.split('-');
  if (!month) return year;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day ?? 1)));
  if (Number.isNaN(parsed.getTime())) return null;
  return day ? fullDate.format(parsed) : monthYear.format(parsed);
}

/**
 * The sources block, numbered. Sources arrive already deduplicated and
 * ordered by the assembler; renumbering or re-sorting them here would break
 * the citation markers in the body, which are numbered against this order.
 */
export function toSourceEntries(sources: readonly SourceData[] = []): SourceEntry[] {
  return sources.map((source, position) => {
    const tier = source.tier ?? null;
    const dateLabel = formatSourceDate(source.date);
    return {
      index: position + 1,
      url: source.url,
      publisher: source.publisher?.trim() || hostLabel(source.url),
      tier,
      tierLabel: tier ? TIER_LABELS[tier] : null,
      dateLabel,
      linkLabel: displayUrl(source.url),
      caution:
        tier === 'unknown'
          ? 'We could not confirm who publishes this page. It is listed because we read it, but nothing here rests on it alone.'
          : dateLabel === null
            ? 'This page shows no publication or update date, so we cannot confirm how current it is. It does not count toward this article’s freshness.'
            : null,
    };
  });
}

/** "7 sources", and "1 source" - the count the evidence rail and the block share. */
export function sourceCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

/** What the review stamp says, and which state it says it in. */
export interface ReviewStatus {
  date: Date;
  /** True when the date is the piece's last edit rather than a logged review. */
  inferred: boolean;
  /** True when the review is older than this category's published cadence. */
  due: boolean;
  daysSince: number;
  /** This category's cadence, in days - what `due` was measured against. */
  intervalDays: number;
  /** When the next re-check falls due, forward-looking and stated up front. */
  nextDue: Date;
}

/**
 * When this piece was last reviewed against its sources.
 *
 * A post published before the pipeline logged reviews carries no `lastReviewed`
 * date. Rather than claiming a review that was never recorded, the stamp falls
 * back to the last edit and says so - `inferred` is what the component uses to
 * change the wording.
 *
 * `due` changes what the stamp says, not what colour it is. An overdue re-check
 * is our failure rather than a defect the reader can act on, and a warning
 * colour over it reads as "something here may be wrong" without saying what -
 * the vague form of uncertainty that costs a publisher trust. Amber on this
 * site is reserved for evidence a reader can weigh: a source we could not
 * attribute, a figure we could not date.
 */
export function reviewStatus(
  post: { lastReviewed?: Date; updatedDate?: Date; pubDate: Date; category?: string },
  now: Date = new Date(),
): ReviewStatus {
  const logged = post.lastReviewed;
  const date = logged ?? post.updatedDate ?? post.pubDate;
  const daysSince = Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
  const intervalDays = reviewIntervalDays(post.category);
  return {
    date,
    inferred: logged === undefined,
    due: daysSince > intervalDays,
    daysSince,
    intervalDays,
    nextDue: new Date(date.getTime() + intervalDays * DAY_MS),
  };
}

/**
 * How long ago the last review was, in the units a shopper thinks in. Used in
 * place of a warning once a re-check falls due: "last checked 14 months ago"
 * is a fact the reader can weigh, where "review overdue" is only an accusation
 * we have levelled at ourselves.
 */
export function agoLabel(daysSince: number): string {
  const months = Math.floor(daysSince / 30);
  if (months < 1) return daysSince === 1 ? '1 day ago' : `${daysSince} days ago`;
  if (months < 24) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(months / 12);
  return `${years} years ago`;
}

/** How many rows of a list carry something we could not verify. */
export function unverifiedCount(entries: readonly SourceEntry[]): number {
  return entries.filter((entry) => entry.caution !== null).length;
}
