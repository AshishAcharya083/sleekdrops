/**
 * The Quick Verdict's score, explained: the band its number falls in, the
 * method it was given under, how the product was assessed, who wrote it and
 * when, and any revision that moved it.
 *
 * Built here as plain data so every fallback the ~320 reviews published before
 * these fields existed lean on is decided in one tested place: no recorded
 * provenance reads as not hands-on, no recorded method version is said plainly
 * rather than guessed, and nothing is printed that the record does not hold.
 * The words for bands, method versions and provenances come from the trust
 * model and the links from the methodology module, so the box cannot drift
 * from the page it links to.
 */

import { formatMedium } from './format.ts';
import { methodologyHref, methodVersionHref } from './methodology.ts';
import {
  assessmentProvenance,
  formatScore,
  methodLabel,
  PROVENANCE_COPY,
  SCORE_BANDS,
  scoreBand,
  weightedScore,
  type MethodVersion,
  type Provenance,
  type ReviewUnitAcquisition,
  type ScoreBand,
  type ScoreBandId,
  type SubScore,
} from './trust.ts';

export interface ScoreExplainerInput {
  /** The post slug, which the analytics hook reports. */
  slug: string;
  product: {
    rating: number;
    methodVersion?: MethodVersion;
    provenance?: Provenance;
    subScores?: readonly SubScore[];
    scoreChange?: { date: Date; from: number; reason: string };
  };
  reviewUnit?: { acquisition: ReviewUnitAcquisition };
  author: { name: string; beat?: string };
  pubDate: Date;
  updatedDate?: Date;
}

/** A day as printed ("Sep 28, 2026") and as machine-readable for `<time>`. */
export interface Day {
  iso: string;
  text: string;
}

export type MethodLine =
  | { version: MethodVersion; label: string; href: string }
  | { version: undefined; statement: string; linkText: string; href: string };

export interface ScoreChangeLine {
  /** "Retested" only when the review was hands-on; a desk revision is "Re-scored". */
  label: 'Retested' | 'Re-scored';
  handsOn: boolean;
  date: Day;
  from: string;
  to: string;
  /** Why it moved, without a closing full stop. */
  reason: string;
  href: string;
}

export interface SubScoreRow {
  label: string;
  weight: string;
  score: string;
  /** Bar length, as a percentage of the 5-point scale. */
  percent: number;
}

export interface ScaleRow {
  id: ScoreBandId;
  label: string;
  meaning: string;
  range: string;
  current: boolean;
}

/** The analytics hook's props, exactly the keys the trust-analytics contract fixes. */
export interface ScoreExplainerHookProps {
  slug: string;
  band: ScoreBandId;
}

export interface ScoreExplainerView {
  score: string;
  band: ScoreBand;
  /** Whether anyone here had the product in hand: bought at retail or a brand sample. */
  handsOn: boolean;
  /** Read beside StarRating's own label, so the band reaches a screen reader too. */
  srSummary: string;
  provenance: { id: Provenance; label: string; statement: string };
  method: MethodLine;
  byline: { name: string; beat?: string; published: Day; updated?: Day };
  change?: ScoreChangeLine;
  subScores?: { rows: SubScoreRow[]; note: string };
  explainer: {
    gist: string;
    paragraphs: string[];
    scale: ScaleRow[];
    methodHref: string;
    distributionHref: string;
    hookProps: ScoreExplainerHookProps;
  };
}

const RESEARCH_GIST =
  'A research score from published tests, owner reports and running costs, not from our own use of the product.';
const HANDS_ON_GIST =
  'A score from our own weeks with the unit, checked against published tests, owner reports and running costs.';

const RESEARCH_CRITERIA =
  'This is a research score, not a test result. Every product is read against the same four criteria: the strength and recency of independent measurements, the measured performance where someone measured it, the failures owners report and how soon they appear, and what it costs to own.';
const RESEARCH_CAVEAT =
  'Thin evidence caps the score, however good the product may be. Commission never enters it: our writers do not see what any retailer pays us.';
// An unversioned score cannot claim the four criteria v1.0 names, so it states
// only the ones every review has been read against.
const UNVERSIONED_RESEARCH_CRITERIA =
  'This is a research score, not a test result. It reads the evidence for the product against the strength and recency of independent measurements, the failures owners report, and what it costs to own.';
const HANDS_ON_CRITERIA =
  'We used the unit day to day for at least two weeks, then read what we found against the same criteria every review uses: independent measurements, the failures owners report and how soon, and what it costs to own.';
const HANDS_ON_CAVEAT =
  'Where our experience and the published evidence disagree, the review says so and the evidence decides. Commission never enters the score: our writers do not see what any retailer pays us.';

function day(date: Date): Day {
  return { iso: date.toISOString().slice(0, 10), text: formatMedium(date) };
}

/** Each band's one-decimal range, "4.0–4.4", topped at 5.0. */
function scaleRows(current: ScoreBand): ScaleRow[] {
  return SCORE_BANDS.map((band, index) => {
    const top = index === 0 ? 5 : SCORE_BANDS[index - 1].min - 0.1;
    return {
      id: band.id,
      label: band.label,
      meaning: band.meaning,
      range: `${formatScore(band.min)}–${formatScore(top)}`,
      current: band.id === current.id,
    };
  });
}

function explainerParagraphs(handsOn: boolean, version: MethodVersion | undefined, rescored: boolean): string[] {
  if (version) return handsOn ? [HANDS_ON_CRITERIA, HANDS_ON_CAVEAT] : [RESEARCH_CRITERIA, RESEARCH_CAVEAT];
  const unversioned = [
    'It was given before we numbered our method, so we cannot tell you which version it used',
    rescored ? '.' : ', and it has not been re-scored since.',
    ' Newer reviews name the method version they were scored under.',
  ].join('');
  return [handsOn ? HANDS_ON_CRITERIA : UNVERSIONED_RESEARCH_CRITERIA, unversioned];
}

function subScoreBreakdown(rating: number, subScores: readonly SubScore[] | undefined) {
  if (!subScores?.length) return undefined;
  const total = weightedScore(subScores);
  const headline = formatScore(rating);
  // The schema holds the sum within 0.05 of the headline, which can still
  // print one decimal off it, so "rounds to" is only said when it does.
  const relation = formatScore(total) === headline ? 'rounds to' : 'is within 0.05 of';
  return {
    rows: subScores.map((entry) => ({
      label: entry.label,
      weight: `${Math.round(entry.weight * 100)}% of score`,
      score: formatScore(entry.score),
      percent: Math.round((entry.score / 5) * 100),
    })),
    note: `The weighted total, ${total.toFixed(2)}, ${relation} the ${headline} above.`,
  };
}

export function scoreExplainer(input: ScoreExplainerInput): ScoreExplainerView {
  const { product } = input;
  const score = formatScore(product.rating);
  const band = scoreBand(product.rating);
  const provenance = assessmentProvenance(product, input.reviewUnit);
  const handsOn = provenance !== 'not-hands-on';
  const version = product.methodVersion;

  const published = day(input.pubDate);
  const updated = input.updatedDate ? day(input.updatedDate) : undefined;

  const change = product.scoreChange && {
    label: handsOn ? ('Retested' as const) : ('Re-scored' as const),
    handsOn,
    date: day(product.scoreChange.date),
    from: formatScore(product.scoreChange.from),
    to: score,
    reason: product.scoreChange.reason.trim().replace(/[.\s]+$/, ''),
    href: methodologyHref('corrections'),
  };

  return {
    score,
    band,
    handsOn,
    srSummary: `${handsOn ? 'Score' : 'Research score'} ${score} out of 5: ${band.label}.`,
    provenance: { id: provenance, ...PROVENANCE_COPY[provenance] },
    method: version
      ? { version, label: methodLabel(version), href: methodVersionHref(version) }
      : {
          version: undefined,
          statement: 'Scored before we numbered our method.',
          linkText: 'How we score',
          href: methodologyHref('bands'),
        },
    byline: {
      name: input.author.name,
      beat: input.author.beat,
      published,
      updated: updated && updated.iso !== published.iso ? updated : undefined,
    },
    change,
    subScores: subScoreBreakdown(product.rating, product.subScores),
    explainer: {
      gist: handsOn ? HANDS_ON_GIST : RESEARCH_GIST,
      paragraphs: explainerParagraphs(handsOn, version, change !== undefined),
      scale: scaleRows(band),
      methodHref: methodologyHref(),
      distributionHref: methodologyHref('distribution'),
      hookProps: { slug: input.slug, band: band.id },
    },
  };
}
