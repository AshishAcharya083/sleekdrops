/**
 * The trust vocabulary reviews and deals share: what a score means, the method
 * that produced it, how the product was assessed, and the closed set of
 * badges either surface may print.
 *
 * It lives in one module so the two surfaces cannot drift into labels of their
 * own. A badge here is never a word: it is a kind from the registry below,
 * carried with the evidence that kind requires and the day somebody checked
 * it, so a claim cannot be entered without what backs it. What the registry
 * deliberately lacks matters as much as what it holds - there is no urgency,
 * scarcity, countdown or endorsement kind ("Editor's choice", "Best value"),
 * because none of those is a statement a reader could check.
 *
 * Plain TypeScript with no Astro imports, and explicit .ts specifiers, so the
 * node --test runner and the frontmatter schema can both load it directly.
 */

import { REVIEW_INTERVAL_DAYS } from './sources.ts';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertNever(value: never): never {
  throw new Error(`unhandled trust value: ${JSON.stringify(value)}`);
}

// --- Score bands -------------------------------------------------------------

export const SCORE_BAND_IDS = ['excellent', 'strong', 'decent', 'mixed', 'weak'] as const;

export type ScoreBandId = (typeof SCORE_BAND_IDS)[number];

export interface ScoreBand {
  id: ScoreBandId;
  /** The one word printed beside the number. */
  label: string;
  /** What the band means, in a reader's words. */
  meaning: string;
  /** The lowest one-decimal score in the band. */
  min: number;
}

/**
 * The scale, highest first.
 *
 * Written to match how this site actually scores rather than how a scale is
 * usually advertised: our average sits near the top band, so "among the best
 * ever made" over 4.5 would tell a reader who sees both numbers that we call
 * almost everything excellent. Each meaning is a recommendation we can stand
 * behind at that score, not a superlative.
 */
export const SCORE_BANDS: readonly ScoreBand[] = [
  { id: 'excellent', label: 'Excellent', min: 4.5, meaning: "We'd recommend this without hesitation." },
  { id: 'strong', label: 'Strong', min: 4.0, meaning: 'A good buy for most people, with trade-offs worth reading first.' },
  { id: 'decent', label: 'Decent', min: 3.5, meaning: 'Worth it if its strengths match what you need.' },
  { id: 'mixed', label: 'Mixed', min: 3.0, meaning: 'Real flaws, and usually a better option at this price.' },
  { id: 'weak', label: 'Weak', min: 1.0, meaning: "We'd steer you elsewhere." },
];

/** The score the way every surface prints it: "4.4". */
export function formatScore(rating: number): string {
  return rating.toFixed(1);
}

/**
 * The band a 1.0-5.0 score falls in.
 *
 * Banded on the score as printed (one decimal), so 4.46 shows as "4.5" and is
 * called Excellent rather than sitting beside the word for the band below.
 * The schema keeps ratings inside the scale; anything outside it is clamped
 * rather than thrown on, so a render never fails over a band word.
 */
export function scoreBand(rating: number): ScoreBand {
  const lowest = SCORE_BANDS[SCORE_BANDS.length - 1];
  if (!Number.isFinite(rating)) return lowest;
  const printed = Number(formatScore(Math.min(5, Math.max(1, rating))));
  return SCORE_BANDS.find((band) => printed >= band.min) ?? lowest;
}

// --- Methodology version -----------------------------------------------------

export type MethodVersion = '1.0';

export interface MethodVersionEntry {
  version: MethodVersion;
  /** The day the version took effect, YYYY-MM-DD. */
  date: string;
  /** What the version is, or what changed from the one before it. */
  summary: string;
}

/**
 * Every published version of the scoring method, oldest first. A review
 * records the version it was scored under, so an older score stays readable
 * against the rules it was actually given rather than being re-judged by
 * newer ones.
 */
export const METHOD_VERSIONS: readonly MethodVersionEntry[] = [
  {
    version: '1.0',
    date: '2026-10-02',
    summary:
      'First published method: one decimal score out of 5, read against the five bands, with a written explanation.',
  },
];

export const METHOD_VERSION_IDS = METHOD_VERSIONS.map((entry) => entry.version) as [
  MethodVersion,
  ...MethodVersion[],
];

export const CURRENT_METHOD_VERSION: MethodVersion = METHOD_VERSIONS[METHOD_VERSIONS.length - 1].version;

/** "Method v1.0". */
export function methodLabel(version: MethodVersion): string {
  return `Method v${version}`;
}

// --- Assessment provenance ---------------------------------------------------

export const PROVENANCES = ['retail', 'brand-sample', 'not-hands-on'] as const;

export type Provenance = (typeof PROVENANCES)[number];

/** The label for each provenance, and the sentence every surface prints verbatim. */
export const PROVENANCE_COPY: Record<Provenance, { label: string; statement: string }> = {
  retail: {
    label: 'Bought at retail',
    statement: 'We bought this product at retail with our own money.',
  },
  'brand-sample': {
    label: 'Brand sample, returned',
    statement: 'The brand supplied this sample for review, and we returned it afterwards.',
  },
  'not-hands-on': {
    label: 'Not hands-on',
    statement: 'We did not handle this product. We assessed it from published specs and owner reports.',
  },
};

/**
 * What a review falls back to when it records nothing: the honest default for
 * a desk that does not test hands-on. Claiming a unit we never held is the
 * failure; saying we held none when we did costs nothing but credit.
 */
export const FALLBACK_PROVENANCE: Provenance = 'not-hands-on';

/** How `reviewUnit.acquisition` (retail / loan / none) says the same thing. */
export type ReviewUnitAcquisition = 'retail' | 'loan' | 'none';

export function provenanceFromAcquisition(acquisition: ReviewUnitAcquisition): Provenance {
  switch (acquisition) {
    case 'retail':
      return 'retail';
    case 'loan':
      return 'brand-sample';
    case 'none':
      return 'not-hands-on';
    default:
      return assertNever(acquisition);
  }
}

/** The provenance a review states: the product's, then its review unit's, then the fallback. */
export function assessmentProvenance(
  product: { provenance?: Provenance } | undefined,
  reviewUnit?: { acquisition: ReviewUnitAcquisition },
): Provenance {
  if (product?.provenance) return product.provenance;
  return reviewUnit ? provenanceFromAcquisition(reviewUnit.acquisition) : FALLBACK_PROVENANCE;
}

// --- Weighted sub-scores -----------------------------------------------------

export interface SubScore {
  label: string;
  score: number;
  /** Share of the headline score, 0-1. A breakdown's weights sum to 1. */
  weight: number;
}

/**
 * How far a breakdown's weighted sum may sit from the headline score: half a
 * printed decimal, so the headline is the weighted sum as it would be printed.
 */
export const SUB_SCORE_TOLERANCE = 0.05;

const WEIGHT_SUM_TOLERANCE = 0.001;
// Absorbs float error so a sum that is exactly on the tolerance passes.
const FLOAT_SLACK = 1e-9;

export function weightedScore(subScores: readonly SubScore[]): number {
  return subScores.reduce((sum, entry) => sum + entry.score * entry.weight, 0);
}

/**
 * Why a breakdown does not add up to its headline, or nothing when it does. A
 * breakdown that does not recompute the number above it is decoration, and a
 * reader who does the sum would rightly stop trusting both.
 */
export function subScoreProblems(rating: number, subScores: readonly SubScore[]): string[] {
  const weights = subScores.reduce((sum, entry) => sum + entry.weight, 0);
  if (Math.abs(weights - 1) > WEIGHT_SUM_TOLERANCE + FLOAT_SLACK) {
    return [`sub-score weights sum to ${weights.toFixed(3)}, not 1`];
  }
  const recomputed = weightedScore(subScores);
  if (Math.abs(recomputed - rating) > SUB_SCORE_TOLERANCE + FLOAT_SLACK) {
    return [
      `sub-scores recompute to ${recomputed.toFixed(2)}, more than ${SUB_SCORE_TOLERANCE} from the headline ${formatScore(rating)}`,
    ];
  }
  return [];
}

// --- Badge registry ----------------------------------------------------------

export const BADGE_KINDS = ['review-score', 'honest-negative', 'lowest-price', 'below-average'] as const;

export type BadgeKind = (typeof BADGE_KINDS)[number];

export interface BadgeDefinition<K extends BadgeKind = BadgeKind> {
  kind: K;
  /** Short glossary name. */
  label: string;
  /** The printed claim; `{placeholders}` are filled by `badgeClaim`. */
  claimTemplate: string;
  /** The evidence key the claim stands on. */
  evidenceField: string;
  /** How many days after `checkedAt` the badge may still be printed. */
  windowDays: number;
  /** Where the proof link lands: the review behind it, or the methodology badge glossary. */
  proof: 'review' | 'glossary';
  /** Off for any kind the site cannot yet back with data it collects. */
  enabled: boolean;
}

export const BADGE_REGISTRY: { readonly [K in BadgeKind]: BadgeDefinition<K> } = {
  'review-score': {
    kind: 'review-score',
    label: 'Review score',
    claimTemplate: '{rating}/5 in our review',
    evidenceField: 'rating',
    // As long as the review behind it stays inside its re-check cadence.
    windowDays: REVIEW_INTERVAL_DAYS,
    proof: 'review',
    enabled: true,
  },
  // A site that sometimes says "not now" is believed when it says "buy". The
  // claim always prints its check date, and fourteen days is its longest life:
  // a price call goes stale fast, and an undated "skip" reads as permanent.
  'honest-negative': {
    kind: 'honest-negative',
    label: 'Skip for now',
    claimTemplate: 'Skip for now - checked {checkedOn}. {note}',
    evidenceField: 'note',
    windowDays: 14,
    proof: 'glossary',
    enabled: true,
  },
  // The price-history kinds are the badges shoppers trust most and the ones we
  // cannot honestly print: nothing here records price checks yet. They are
  // defined so recording one is all it takes, and stay off until then. Each
  // check stands for a day, since a price can move the next.
  'lowest-price': {
    kind: 'lowest-price',
    label: 'Lowest tracked price',
    claimTemplate: 'Lowest price we have tracked in 90 days',
    evidenceField: 'observations',
    windowDays: 1,
    proof: 'glossary',
    enabled: false,
  },
  'below-average': {
    kind: 'below-average',
    label: 'Below its average price',
    claimTemplate: '{below} below its 30-day average',
    evidenceField: 'observations',
    windowDays: 1,
    proof: 'glossary',
    enabled: false,
  },
};

/** A badge as entered: a registry kind, the evidence that kind requires and the day it was checked. */
export type DealBadge =
  | { kind: 'review-score'; evidence: { reviewSlug: string; rating: number }; checkedAt: string }
  | { kind: 'honest-negative'; evidence: { note: string }; checkedAt: string }
  | {
      kind: 'lowest-price';
      /** Formatted prices ("A$449") and how many price checks the 90 days hold. */
      evidence: { price: string; previousLowest: string; observations: number };
      checkedAt: string;
    }
  | {
      kind: 'below-average';
      /** `below` is the pre-formatted gap, e.g. "A$41". */
      evidence: { price: string; average: string; below: string; observations: number };
      checkedAt: string;
    };

export function isBadgeKind(value: unknown): value is BadgeKind {
  return typeof value === 'string' && (BADGE_KINDS as readonly string[]).includes(value);
}

const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
// One sighting of a price is not a history.
const priceHistory = (value: unknown) => Number.isInteger(value) && (value as number) >= 2;

/** Whether a value is a real calendar day: the pattern alone lets "2026-02-30" roll into March. */
export function isCheckDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Why a badge could not be printed as entered, or nothing when it could:
 * its kind, its evidence, its check date and whether the kind is switched on.
 * Takes `unknown` because deals and frontmatter are typed by hand, and a
 * disabled kind is reported rather than silently hidden so nobody publishes a
 * claim believing it is live.
 */
export function badgeProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['a badge must be { kind, evidence, checkedAt }'];
  const { kind, evidence, checkedAt } = value as Record<string, unknown>;
  if (!isBadgeKind(kind)) return [`"${String(kind)}" is not a badge kind in the registry`];
  const problems: string[] = [];
  if (!BADGE_REGISTRY[kind].enabled) {
    problems.push(`badge kind "${kind}" is switched off until the data behind it is collected`);
  }
  if (!isCheckDay(checkedAt)) problems.push('checkedAt must be a real YYYY-MM-DD day');
  const e = (typeof evidence === 'object' && evidence !== null ? evidence : {}) as Record<string, unknown>;
  const missing = (keys: Record<string, (value: unknown) => boolean>) => {
    for (const [key, valid] of Object.entries(keys)) {
      if (!valid(e[key])) problems.push(`evidence.${key} is missing or empty`);
    }
  };
  switch (kind) {
    case 'review-score':
      missing({
        reviewSlug: (slug) => typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
        rating: (rating) => typeof rating === 'number' && rating >= 1 && rating <= 5,
      });
      break;
    case 'honest-negative':
      missing({ note: filled });
      break;
    case 'lowest-price':
      missing({ price: filled, previousLowest: filled, observations: priceHistory });
      break;
    case 'below-average':
      missing({ price: filled, average: filled, below: filled, observations: priceHistory });
      break;
    default:
      return assertNever(kind);
  }
  return problems;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-02" as "2 Oct", the way a check date is printed inside a claim. */
export function formatCheckDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return `${date} ${MONTHS[month - 1]}`;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '').trim();
}

/** The review-score claim for a rating: "4.4/5 in our review". */
export function reviewScoreClaim(rating: number): string {
  return fillTemplate(BADGE_REGISTRY['review-score'].claimTemplate, { rating: formatScore(rating) });
}

/** The badge's printed claim, its registry template filled from the evidence. */
export function badgeClaim(badge: DealBadge): string {
  switch (badge.kind) {
    case 'review-score':
      return reviewScoreClaim(badge.evidence.rating);
    case 'honest-negative':
      return fillTemplate(BADGE_REGISTRY[badge.kind].claimTemplate, {
        checkedOn: formatCheckDay(badge.checkedAt),
        note: badge.evidence.note.trim(),
      });
    case 'lowest-price':
      return fillTemplate(BADGE_REGISTRY[badge.kind].claimTemplate, {});
    case 'below-average':
      return fillTemplate(BADGE_REGISTRY[badge.kind].claimTemplate, { below: badge.evidence.below });
    default:
      return assertNever(badge);
  }
}

/**
 * The calendar day a moment falls on in Sydney, the publication's own day.
 * A check date is a day a person in Australia states, so comparing it to the
 * build server's UTC day would age every badge by one for ten hours a day.
 */
function sydneyDay(moment: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(moment);
}

/**
 * Whether a badge may be printed on `asOf` - the build, since pages are
 * static: its kind is switched on, its evidence is all there, and `asOf` is
 * no later than `windowDays` after the check. A check dated after `asOf` has
 * not happened yet and does not count. Never throws.
 */
export function isBadgeLive(badge: DealBadge, asOf: Date): boolean {
  try {
    if (badgeProblems(badge).length > 0 || Number.isNaN(asOf.getTime())) return false;
    const ageDays = (Date.parse(sydneyDay(asOf)) - Date.parse(badge.checkedAt)) / DAY_MS;
    return ageDays >= 0 && ageDays <= BADGE_REGISTRY[badge.kind].windowDays;
  } catch {
    return false;
  }
}

/**
 * The most items in one listing that may carry a badge, however long it is.
 * A grid in which every card is badged tells the reader nothing about any of them.
 */
export const MAX_BADGED_PER_LISTING = 3;

/**
 * How many badges a listing of `itemCount` items should carry: about one in
 * five, at least one, never more than `ceiling`. A badge only stands out
 * among plain neighbours, so a short list earns fewer - 1 for up to 9 items,
 * 2 for 10-14 and 3 from 15. Pass it as `capBadged`'s `max`.
 */
export function badgeAllowance(itemCount: number, ceiling: number = MAX_BADGED_PER_LISTING): number {
  return Math.max(1, Math.min(ceiling, Math.floor(itemCount * 0.2)));
}

/**
 * Splits a listing at the badge cap, keeping list order. `overCap` holds the
 * badged items beyond the first `max`, which still render but without their
 * badge; `withinCap` holds every other item, badged or not. Never throws.
 */
export function capBadged<T>(
  items: readonly T[],
  isBadged: (item: T) => boolean,
  max: number = MAX_BADGED_PER_LISTING,
): { withinCap: T[]; overCap: T[] } {
  const withinCap: T[] = [];
  const overCap: T[] = [];
  let badged = 0;
  for (const item of items) {
    let hasBadge = false;
    try {
      hasBadge = isBadged(item);
    } catch {
      hasBadge = false;
    }
    if (hasBadge && badged >= max) {
      overCap.push(item);
      continue;
    }
    if (hasBadge) badged += 1;
    withinCap.push(item);
  }
  return { withinCap, overCap };
}

// --- Product (review) badges -------------------------------------------------

/**
 * The kinds a review's `product.badge` may name. A review carries the
 * evidence for these itself - its own rating, slug and dates - so naming the
 * kind is the whole entry. The others need evidence a review does not hold.
 */
export const PRODUCT_BADGE_KINDS = ['review-score'] as const satisfies readonly BadgeKind[];

export type ProductBadgeKind = (typeof PRODUCT_BADGE_KINDS)[number];

/**
 * Why a review's `product.badge` may not stand, or nothing when it may. A
 * string that is not a registry kind is a legacy label from before the
 * registry: it validates so older posts keep building, and is never printed.
 */
export function productBadgeProblems(badge: string): string[] {
  if (!isBadgeKind(badge)) return [];
  if (!BADGE_REGISTRY[badge].enabled) {
    return [`badge kind "${badge}" is switched off until the data behind it is collected`];
  }
  if (!(PRODUCT_BADGE_KINDS as readonly string[]).includes(badge)) {
    return [`badge kind "${badge}" needs evidence a review does not carry, so it belongs on a deal`];
  }
  return [];
}

/** A review's badge as a registry kind, or undefined for none or a legacy label. */
export function productBadgeKind(badge: string | undefined): ProductBadgeKind | undefined {
  return (PRODUCT_BADGE_KINDS as readonly (string | undefined)[]).includes(badge)
    ? (badge as ProductBadgeKind)
    : undefined;
}

/**
 * The claim a review's own badge prints, or undefined when it names no
 * registry kind. The review is its own evidence, so the claim is its rating.
 */
export function productBadgeClaim(product: { badge?: string; rating: number }): string | undefined {
  return productBadgeKind(product.badge) === 'review-score' ? reviewScoreClaim(product.rating) : undefined;
}
