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
 * Explicit .ts extensions: this module is loaded directly by the node --test
 * runner (see trust.test.ts), which needs real specifiers.
 */

import { z } from 'astro/zod';

import { webUrl } from '../content/web-url.ts';
import { REVIEW_INTERVAL_DAYS } from './sources.ts';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertNever(value: never): never {
  throw new Error(`unhandled trust value: ${JSON.stringify(value)}`);
}

// --- Score bands -------------------------------------------------------------

export const scoreBandIds = ['excellent', 'strong', 'decent', 'mixed', 'weak'] as const;

export type ScoreBandId = (typeof scoreBandIds)[number];

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
export const scoreBands: readonly ScoreBand[] = [
  { id: 'excellent', label: 'Excellent', min: 4.5, meaning: "We'd recommend this without hesitation." },
  { id: 'strong', label: 'Strong', min: 4.0, meaning: 'A good buy for most people, with trade-offs worth reading first.' },
  { id: 'decent', label: 'Decent', min: 3.5, meaning: 'Worth it if its strengths match what you need.' },
  { id: 'mixed', label: 'Mixed', min: 3.0, meaning: 'Real flaws, and usually a better option at this price.' },
  { id: 'weak', label: 'Weak', min: 1.0, meaning: "We'd steer you elsewhere." },
];

/**
 * The band a 1.0-5.0 score falls in.
 *
 * Banded on the score as printed (one decimal), so 4.46 shows as "4.5" and is
 * called Excellent rather than sitting beside the word for the band below.
 */
export function scoreBand(score: number): ScoreBand {
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new RangeError(`a score must be between 1.0 and 5.0, got ${score}`);
  }
  const printed = Number(formatScore(score));
  const band = scoreBands.find((candidate) => printed >= candidate.min);
  // Unreachable while the lowest band starts at the scale's floor.
  if (!band) throw new RangeError(`no band covers ${score}`);
  return band;
}

/** The score the way every surface prints it: "4.4". */
export function formatScore(score: number): string {
  return score.toFixed(1);
}

// --- Methodology version -----------------------------------------------------

/**
 * Every published version of the scoring method, oldest first, each with the
 * day it took effect and what changed. A review records the version it was
 * scored under, so an older score stays readable against the rules it was
 * actually given rather than being re-judged by newer ones.
 */
export const methodVersions = [
  {
    version: '1.0',
    effective: '2026-10-02',
    changes:
      'First published method: one decimal score out of 5, read against the five bands, with a written explanation.',
  },
] as const;

export type MethodVersion = (typeof methodVersions)[number]['version'];

export const methodVersionIds = methodVersions.map((entry) => entry.version) as [
  MethodVersion,
  ...MethodVersion[],
];

export const CURRENT_METHOD_VERSION: MethodVersion = methodVersions[methodVersions.length - 1].version;

/** "Method v1.0". */
export function methodLabel(version: MethodVersion): string {
  return `Method v${version}`;
}

// --- Assessment provenance ---------------------------------------------------

/**
 * How the product was assessed. The same three values `reviewUnit.acquisition`
 * has always carried, so the two never disagree about what they mean.
 */
export const assessmentProvenances = ['retail', 'loan', 'none'] as const;

export type AssessmentProvenance = (typeof assessmentProvenances)[number];

/**
 * What a review falls back to when it records nothing: the honest default for
 * a desk that does not test hands-on. Claiming a unit we never held is the
 * failure; saying we held none when we did costs nothing but credit.
 */
export const FALLBACK_PROVENANCE: AssessmentProvenance = 'none';

export function provenanceLabel(provenance: AssessmentProvenance): string {
  switch (provenance) {
    case 'retail':
      return 'Bought at retail by us';
    case 'loan':
      return 'Sample supplied by the brand and returned';
    case 'none':
      return 'Not hands-on: assessed from published specs and owner reports';
    default:
      return assertNever(provenance);
  }
}

/** The provenance a review states, from the product, then the review unit, then the fallback. */
export function assessmentProvenance(
  product: { provenance?: AssessmentProvenance } | undefined,
  reviewUnit?: { acquisition: AssessmentProvenance },
): AssessmentProvenance {
  return product?.provenance ?? reviewUnit?.acquisition ?? FALLBACK_PROVENANCE;
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
  const problems: string[] = [];
  const weights = subScores.reduce((sum, entry) => sum + entry.weight, 0);
  if (Math.abs(weights - 1) > WEIGHT_SUM_TOLERANCE + FLOAT_SLACK) {
    problems.push(`sub-score weights sum to ${weights.toFixed(3)}, not 1`);
    return problems;
  }
  const recomputed = weightedScore(subScores);
  if (Math.abs(recomputed - rating) > SUB_SCORE_TOLERANCE + FLOAT_SLACK) {
    problems.push(
      `sub-scores recompute to ${recomputed.toFixed(2)}, more than ${SUB_SCORE_TOLERANCE} from the headline ${formatScore(rating)}`,
    );
  }
  return problems;
}

// --- Badge registry ----------------------------------------------------------

export const badgeKinds = ['review-score', 'lowest-price', 'below-average', 'skip-for-now'] as const;

export type BadgeKind = (typeof badgeKinds)[number];

export type BadgeFamily = 'quality' | 'price-history' | 'honest-negative';

/** Where a badge's proof link lands: the review behind it, or the source the check was made against. */
export type BadgeProofTarget = 'review' | 'source';

const formattedPrice = z.string().min(1);

/** The evidence each kind cannot be entered without. */
const badgeEvidence = {
  'review-score': z
    .object({
      score: z.number().min(1).max(5),
      /** The post the score is from - the proof link. */
      reviewSlug: z.string().regex(SLUG),
    })
    .strict(),
  'lowest-price': z
    .object({
      /** The price on the check date, e.g. "A$449". */
      price: formattedPrice,
      /** The lowest price seen in the window before it. */
      previousLowest: formattedPrice,
      /** Price checks recorded across the window - one sighting is not a history. */
      observations: z.number().int().min(2),
      sourceUrl: webUrl(),
    })
    .strict(),
  'below-average': z
    .object({
      price: formattedPrice,
      average: formattedPrice,
      /** Pre-formatted gap, e.g. "$41". */
      below: formattedPrice,
      observations: z.number().int().min(2),
      sourceUrl: webUrl(),
    })
    .strict(),
  'skip-for-now': z
    .object({
      /** Why not now, as a checkable fact: "it was A$60 cheaper in July". */
      reason: z.string().min(1),
      sourceUrl: webUrl(),
    })
    .strict(),
} satisfies Record<BadgeKind, z.ZodTypeAny>;

export interface BadgeDefinition<K extends BadgeKind = BadgeKind> {
  family: BadgeFamily;
  /** The printed claim; `{placeholders}` are filled from the evidence by `badgeClaimText`. */
  claimTemplate: string;
  /** The evidence payload the kind requires. */
  evidence: (typeof badgeEvidence)[K];
  /** How far back from the check date the evidence looks, or null when the claim looks back at nothing. */
  observationDays: number | null;
  /** How long after its check date the badge may still be printed. */
  validForDays: number;
  /** What the badge's `checkedAt` records. */
  checkDate: string;
  proof: BadgeProofTarget;
  /** Off for any kind the site cannot yet back with data it collects. */
  enabled: boolean;
}

export const badgeRegistry: { readonly [K in BadgeKind]: BadgeDefinition<K> } = {
  'review-score': {
    family: 'quality',
    claimTemplate: '{score}/5 in our review',
    evidence: badgeEvidence['review-score'],
    observationDays: null,
    validForDays: REVIEW_INTERVAL_DAYS,
    checkDate: 'The day the review behind the score was last checked against its sources.',
    proof: 'review',
    enabled: true,
  },
  // The two price-history kinds are the badges shoppers trust most and the
  // ones we cannot honestly print: nothing here records price checks yet.
  // They are defined so recording one is all it takes, and stay off until then.
  'lowest-price': {
    family: 'price-history',
    claimTemplate: 'Lowest price in {observationDays} days',
    evidence: badgeEvidence['lowest-price'],
    observationDays: 90,
    validForDays: 1,
    checkDate: 'The day the current price was seen.',
    proof: 'source',
    enabled: false,
  },
  'below-average': {
    family: 'price-history',
    claimTemplate: '{below} below its {observationDays}-day average',
    evidence: badgeEvidence['below-average'],
    observationDays: 30,
    validForDays: 1,
    checkDate: 'The day the current price was seen.',
    proof: 'source',
    enabled: false,
  },
  // A site that sometimes says "not now" is believed when it says "buy".
  'skip-for-now': {
    family: 'honest-negative',
    claimTemplate: 'Skip for now: {reason}',
    evidence: badgeEvidence['skip-for-now'],
    observationDays: null,
    validForDays: 14,
    checkDate: 'The day the reason was checked.',
    proof: 'source',
    enabled: true,
  },
};

/** A real calendar day: the regex alone would let "2026-02-30" roll over into March. */
const checkedAt = z
  .string()
  .regex(ISO_DAY)
  .refine(
    (day) => {
      const parsed = new Date(`${day}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
    },
    { message: 'must be a real calendar day' },
  );

/** A badge as entered: a registry kind, its evidence and the day it was checked. */
export const badgeClaimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review-score'), evidence: badgeEvidence['review-score'], checkedAt }).strict(),
  z.object({ kind: z.literal('lowest-price'), evidence: badgeEvidence['lowest-price'], checkedAt }).strict(),
  z.object({ kind: z.literal('below-average'), evidence: badgeEvidence['below-average'], checkedAt }).strict(),
  z.object({ kind: z.literal('skip-for-now'), evidence: badgeEvidence['skip-for-now'], checkedAt }).strict(),
]);

export type BadgeClaim = z.infer<typeof badgeClaimSchema>;

/**
 * Why a badge may not be entered, or nothing when it may: its shape, then
 * whether its kind is switched on. A disabled kind is refused rather than
 * silently hidden, so nobody publishes a claim believing it is live.
 */
export function badgeProblems(value: unknown): string[] {
  const parsed = badgeClaimSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.') || 'badge'}: ${issue.message}`);
  }
  if (!badgeRegistry[parsed.data.kind].enabled) {
    return [`badge kind "${parsed.data.kind}" is switched off until the data behind it is collected`];
  }
  return [];
}

function claimValues(badge: BadgeClaim): Record<string, string> {
  const { observationDays } = badgeRegistry[badge.kind];
  const window: Record<string, string> =
    observationDays === null ? {} : { observationDays: String(observationDays) };
  switch (badge.kind) {
    case 'review-score':
      return { ...window, score: formatScore(badge.evidence.score) };
    case 'lowest-price':
      return { ...window, price: badge.evidence.price };
    case 'below-average':
      return { ...window, below: badge.evidence.below };
    case 'skip-for-now':
      return { ...window, reason: badge.evidence.reason };
    default:
      return assertNever(badge);
  }
}

/** The badge's printed claim: "4.4/5 in our review". */
export function badgeClaimText(badge: BadgeClaim): string {
  const values = claimValues(badge);
  return badgeRegistry[badge.kind].claimTemplate.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`badge "${badge.kind}" has no value for {${key}}`);
    return value;
  });
}

/** Where the badge's proof link points. */
export function badgeProofHref(badge: BadgeClaim): string {
  switch (badge.kind) {
    case 'review-score':
      return `/blog/${badge.evidence.reviewSlug}`;
    case 'lowest-price':
    case 'below-average':
    case 'skip-for-now':
      return badge.evidence.sourceUrl;
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
 * Whether a badge's check still stands on `asOf` - the build, since the page
 * is static. A check dated after `asOf` has not happened yet and does not.
 */
export function badgeInWindow(badge: BadgeClaim, asOf: Date = new Date()): boolean {
  const ageDays = (Date.parse(sydneyDay(asOf)) - Date.parse(badge.checkedAt)) / DAY_MS;
  return ageDays >= 0 && ageDays <= badgeRegistry[badge.kind].validForDays;
}

/** The badge to print, or null when it is switched off or its check has lapsed. */
export function displayableBadge(badge: BadgeClaim | undefined, asOf: Date = new Date()): BadgeClaim | null {
  if (!badge || !badgeRegistry[badge.kind].enabled || !badgeInWindow(badge, asOf)) return null;
  return badge;
}

/**
 * The most items in one list that may carry a badge. A grid in which every
 * card is badged tells the reader nothing about any of them.
 */
export const MAX_BADGED_PER_LIST = 3;

export interface BadgedItem<T> {
  item: T;
  badge: BadgeClaim | null;
}

/**
 * Pairs each item with the badge it may print, in list order, keeping badges
 * on at most `max` items. Items past the cap are kept - only their badge goes.
 */
export function capBadged<T>(
  items: readonly T[],
  badgeOf: (item: T) => BadgeClaim | undefined,
  max: number = MAX_BADGED_PER_LIST,
  asOf: Date = new Date(),
): BadgedItem<T>[] {
  let badged = 0;
  return items.map((item) => {
    const badge = badged < max ? displayableBadge(badgeOf(item), asOf) : null;
    if (badge) badged += 1;
    return { item, badge };
  });
}

/**
 * A product's badge as a registry claim. A legacy free-text label ("Editor's
 * choice") still validates so older posts keep building, but carries no
 * evidence and is never printed.
 */
export function registryBadge(value: BadgeClaim | string | undefined): BadgeClaim | undefined {
  return typeof value === 'string' ? undefined : value;
}

export interface CalloutLabel {
  text: string;
  /** The badge's proof link, when it lands somewhere other than the page itself. */
  href?: string;
}

/**
 * The label above a product callout: an explicit one, else the product's
 * badge while it is printable, else the post's kind, else none. There is no
 * endorsement default - "Editor's choice" over every product is a word with
 * no evidence, read as a guarantee we have not made.
 */
export function productCalloutLabel(
  options: { badge?: BadgeClaim | string; kind?: string; eyebrow?: string; postSlug: string },
  asOf: Date = new Date(),
): CalloutLabel | null {
  if (options.eyebrow) return { text: options.eyebrow };
  const badge = displayableBadge(registryBadge(options.badge), asOf);
  if (badge) {
    const text = badgeClaimText(badge);
    const href = badgeProofHref(badge);
    // A review's own score badge is proved by the page it sits on.
    return href === `/blog/${options.postSlug}` ? { text } : { text, href };
  }
  return options.kind ? { text: options.kind } : null;
}
