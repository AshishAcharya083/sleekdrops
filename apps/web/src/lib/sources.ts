/**
 * The reader's view of an article's evidence: the numbered sources block at
 * the foot of a piece, and the review stamp under its byline.
 *
 * Everything here is a pure transform of frontmatter the agent's assembler
 * wrote from the research dossier (apps/agent/src/content/sources.ts), so the
 * list a reader sees is the list the research actually produced - same order,
 * same numbering the body's citation markers use. Nothing is inferred: a
 * source with no date is shown as undated, a source the researcher could not
 * place is shown as unplaced.
 *
 * Explicit .ts extensions: this module is loaded directly by the node --test
 * runner (see sources.test.ts), which needs real specifiers.
 */

import type { SourceData, SourceTier } from '../content/frontmatter.ts';

/** What each tier means to a reader, in the reader's words. */
export const TIER_LABELS: Record<SourceTier, string> = {
  primary: 'Maker or retailer',
  expert: 'Independent testing',
  owner: 'Owner reports',
  aggregator: 'Aggregated data',
  unknown: 'Unplaced',
};

/** The tiers that carry the most weight, strongest first - the order the methodology page documents. */
export const TIER_ORDER: SourceTier[] = ['expert', 'primary', 'owner', 'aggregator', 'unknown'];

/** How long a piece may go between reviews before the stamp says it is due. */
export const REVIEW_INTERVAL_DAYS = 365;

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
          ? 'We could not establish who published this or how the figure was produced.'
          : dateLabel === null
            ? 'This source carries no publication date, so we cannot say how current it is.'
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
  /** True when the review is older than the published cadence. */
  due: boolean;
  daysSince: number;
}

/**
 * When this piece was last reviewed against its sources.
 *
 * A post published before the pipeline logged reviews carries no `lastReviewed`
 * date. Rather than claiming a review that was never recorded, the stamp falls
 * back to the last edit and says so - `inferred` is what the component uses to
 * change the wording, not only the colour.
 */
export function reviewStatus(
  post: { lastReviewed?: Date; updatedDate?: Date; pubDate: Date },
  now: Date = new Date(),
): ReviewStatus {
  const logged = post.lastReviewed;
  const date = logged ?? post.updatedDate ?? post.pubDate;
  const daysSince = Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
  return {
    date,
    inferred: logged === undefined,
    due: daysSince > REVIEW_INTERVAL_DAYS,
    daysSince,
  };
}
