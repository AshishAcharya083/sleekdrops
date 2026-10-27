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
 * model, and the links and the "how we scored this" text from the methodology
 * module, so the box cannot drift from the page it links to.
 */

import type { ScoreChange } from '../data/score-changes.ts';
import { formatMedium } from './format.ts';
import {
  dayAsDate,
  methodologyHref,
  methodVersionHref,
  SCORING_SUMMARY,
  UNVERSIONED_SCORE_NOTE,
} from './methodology.ts';
import {
  assessmentProvenance,
  formatScore,
  METHOD_VERSIONS,
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
  };
  /** This review's entries in the public score-change log, newest first. */
  scoreChanges: readonly ScoreChange[];
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
  /**
   * "Retested" only on a hands-on review; a review assessed from published
   * data says "Re-scored", so a move is never read as a hands-on test.
   */
  label: 'Retested' | 'Re-scored';
  date: Day;
  from: string;
  to: string;
  /** Why it moved, as a sentence: capitalised, with its closing full stop. */
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

/**
 * What the score was given under: the method version's own summary, or, for
 * a review that records none, the methodology's note for unversioned scores.
 */
function methodNote(version: MethodVersion | undefined): string {
  if (!version) return UNVERSIONED_SCORE_NOTE;
  const entry = METHOD_VERSIONS.find((candidate) => candidate.version === version);
  if (!entry) throw new Error(`score-explainer: no METHOD_VERSIONS entry for method version ${version}`);
  return entry.summary;
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

/**
 * The newest move in the public score-change log. It must land on the score
 * the review prints, or the box and the log would tell two stories.
 */
function latestChange(
  slug: string,
  rating: number,
  changes: readonly ScoreChange[],
  handsOn: boolean,
): ScoreChangeLine | undefined {
  const latest = changes[0];
  if (!latest) return undefined;
  if (formatScore(latest.to) !== formatScore(rating)) {
    throw new Error(
      `score-changes.ts: the ${latest.date} change for "${slug}" moves the score to ${formatScore(latest.to)}, but the review prints ${formatScore(rating)}`,
    );
  }
  return {
    label: handsOn ? 'Retested' : 'Re-scored',
    date: day(dayAsDate(latest.date)),
    from: formatScore(latest.from),
    to: formatScore(latest.to),
    reason: asSentence(latest.reason),
    href: methodologyHref('corrections'),
  };
}

/** "owner reports of hinge cracks" -> "Owner reports of hinge cracks." */
function asSentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '');
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
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

  const change = latestChange(input.slug, product.rating, input.scoreChanges, handsOn);

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
      // SCORING_SUMMARY says we do not test products, which a hands-on review
      // would contradict; the methodology exports no hands-on wording, so
      // those reviews lead with the method note alone.
      gist: handsOn ? methodNote(version) : SCORING_SUMMARY,
      paragraphs: handsOn ? [] : [methodNote(version)],
      scale: scaleRows(band),
      methodHref: methodologyHref(),
      distributionHref: methodologyHref('distribution'),
      hookProps: { slug: input.slug, band: band.id },
    },
  };
}
