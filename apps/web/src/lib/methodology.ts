/**
 * The /how-we-rate methodology page: its addresses, the sentences other pages
 * quote from it, and the arithmetic behind what it publishes.
 *
 * Every score, badge and disclosure on the site links here, so nothing outside
 * this module hand-writes a /how-we-rate URL or retypes its copy. The page
 * itself renders from these exports and from src/lib/trust.ts, which is what
 * keeps the published scale, changelog and glossary from drifting away from the
 * code that applies them.
 *
 * Plain TypeScript with explicit .ts specifiers, so the node --test runner can
 * load it directly.
 */

import type { CategorySlug } from '../data/categories-types.ts';
import type { ScoreChange } from '../data/score-changes.ts';
import {
  METHOD_VERSIONS,
  SCORE_BANDS,
  methodLabel,
  scoreBand,
  type BadgeKind,
  type MethodVersion,
  type MethodVersionEntry,
  type ScoreBand,
  type ScoreBandId,
} from './trust.ts';

// --- Addresses ---------------------------------------------------------------

export const METHODOLOGY_PATH = '/how-we-rate';

export type MethodologySection =
  | 'bands'
  | 'distribution'
  | 'assessment'
  | 'changelog'
  | 'badges'
  | 'independence'
  | 'corrections'
  | 'score-changes'
  | 'categories';

/** "/how-we-rate", or "/how-we-rate#bands" for one section. */
export function methodologyHref(section?: MethodologySection): string {
  return section ? `${METHODOLOGY_PATH}#${section}` : METHODOLOGY_PATH;
}

/** "method-v1-0": the changelog entry's id. src/lib/seo.ts links the Review JSON-LD to the same anchor. */
export function methodVersionAnchor(version: MethodVersion): string {
  return `method-v${version.replace(/\./g, '-')}`;
}

export function methodVersionHref(version: MethodVersion): string {
  return `${METHODOLOGY_PATH}#${methodVersionAnchor(version)}`;
}

export function scoreBandAnchor(id: ScoreBandId): string {
  return `band-${id}`;
}

export function scoreBandHref(id: ScoreBandId): string {
  return `${METHODOLOGY_PATH}#${scoreBandAnchor(id)}`;
}

export function badgeAnchor(kind: BadgeKind): string {
  return `badge-${kind}`;
}

export function badgeGlossaryHref(kind: BadgeKind): string {
  return `${METHODOLOGY_PATH}#${badgeAnchor(kind)}`;
}

export function categoryAnchor(slug: CategorySlug): string {
  return `category-${slug}`;
}

export function categoryMethodHref(slug: CategorySlug): string {
  return `${METHODOLOGY_PATH}#${categoryAnchor(slug)}`;
}

// --- Quotable copy -----------------------------------------------------------

/** The disclosure printed beside every buy button, by PaidLinkNote. */
export const PAID_LINK_NOTE = 'Paid link. We may earn a commission if you buy. It never affects the score.';

/** How a score is given, in the few sentences a score explainer prints. */
export const SCORING_SUMMARY =
  'Every SleekDrops score is a research score out of 5, given in tenths. We do not test products: a score is our reading of published tests, specifications and owner reports. Each score carries a one-word band and the method version it was given under.';

/**
 * Beside a score whose review records no method version - every review
 * published before versions were recorded. It names no version, because the
 * review does not say which one it was given under.
 */
export const UNVERSIONED_SCORE_NOTE =
  'Scored before reviews recorded a method version, on the same scale and bands we publish today.';

/** The plain statement the assessment section opens with. */
export const NOT_TESTED_STATEMENT =
  'We do not test products. Every review we publish is researched, not handled: nobody at SleekDrops uses the product before scoring it.';

/** How products are assessed, in one paragraph. */
export const ASSESSMENT_SUMMARY = `${NOT_TESTED_STATEMENT} Each product is assessed from published specifications, independent test results and owner reports, and every review lists its sources with the publisher and the date.`;

export interface IndependenceRule {
  title: string;
  /** The mechanism, as a sentence that stands on its own when quoted. */
  statement: string;
  /** How a reader can see the rule holding. */
  proof: { label: 'Check' | 'In practice'; text: string };
}

/** Independence stated as rules a reader can check, not as a promise. */
export const INDEPENDENCE_RULES: readonly IndependenceRule[] = [
  {
    title: 'No sponsored posts',
    statement: 'No brand or retailer pays for an article, a place in a list, or a score, and we do not sell them.',
    proof: { label: 'Check', text: 'Every review says how we got the product, next to its score.' },
  },
  {
    title: 'Writers never see commission rates',
    statement:
      'Writers never see commission rates: they are held in the link system, which the people writing and scoring reviews cannot open.',
    proof: { label: 'In practice', text: 'A writer can see which shop a link goes to, never what it pays.' },
  },
  {
    title: 'No commercial party can change a score',
    statement:
      'No commercial party can change a published score: it changes only through a re-check, a correction or a new method version, and every change is logged publicly with its reason.',
    proof: { label: 'Check', text: 'The score-change log below.' },
  },
  {
    title: 'We link the best retailer, paid or not',
    statement:
      'Where the best price or terms are at a shop with no affiliate program, we link that shop and earn nothing from it.',
    proof: { label: 'Check', text: 'Links without a commission tag earn us nothing.' },
  },
];

/** The independence mechanism sentences, verbatim. */
export const INDEPENDENCE_MECHANISM: readonly string[] = INDEPENDENCE_RULES.map((rule) => rule.statement);

// --- The scale and the scores given ------------------------------------------

/** A band's printed range: "4.5–5.0", or "Below 3.0" for the lowest band. */
export function bandRange(band: ScoreBand, bands: readonly ScoreBand[] = SCORE_BANDS): string {
  const index = bands.findIndex((entry) => entry.id === band.id);
  if (index === bands.length - 1 && index > 0) return `Below ${bands[index - 1].min.toFixed(1)}`;
  const top = index === 0 ? 5 : bands[index - 1].min - 0.1;
  return `${band.min.toFixed(1)}–${top.toFixed(1)}`;
}

export interface BandCount {
  band: ScoreBand;
  count: number;
  /** count / total, 0-1; 0 when there are no scores. */
  share: number;
}

export interface ScoreDistribution {
  count: number;
  /** Mean and median of the scores; undefined when there are none. */
  average?: number;
  median?: number;
  /** One entry per band, highest first, including empty bands. */
  bands: BandCount[];
}

/** How the published scores spread across the bands. */
export function scoreDistribution(ratings: readonly number[]): ScoreDistribution {
  const count = ratings.length;
  const bands = SCORE_BANDS.map((band) => {
    const inBand = ratings.filter((rating) => scoreBand(rating).id === band.id).length;
    return { band, count: inBand, share: count === 0 ? 0 : inBand / count };
  });
  if (count === 0) return { count, bands };
  const sorted = [...ratings].sort((a, b) => a - b);
  const middle = Math.floor(count / 2);
  const median = count % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const average = ratings.reduce((sum, rating) => sum + rating, 0) / count;
  return { count, average, median, bands };
}

/** "75%", or "<1%" for a share that is there but rounds to nothing. */
export function formatShare(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

// --- Method changelog --------------------------------------------------------

/** Changelog entries shown before the rest fold into a disclosure. */
export const CHANGELOG_VISIBLE = 2;

/** Published scores below the Strong band listed before the rest fold away. */
export const LOW_SCORES_VISIBLE = 5;

export type ChangelogKind = 'first' | 'major' | 'minor';

export const CHANGELOG_KIND_LABELS: Record<ChangelogKind, string> = {
  first: 'First version',
  major: 'Major',
  minor: 'Minor',
};

export interface ChangelogEntry extends MethodVersionEntry {
  anchor: string;
  kind: ChangelogKind;
  current: boolean;
}

const majorOf = (version: string) => version.split('.')[0];

/** The method versions newest first, each with its anchor, kind and whether it is current. */
export function methodChangelog(versions: readonly MethodVersionEntry[] = METHOD_VERSIONS): ChangelogEntry[] {
  return versions
    .map((entry, index): ChangelogEntry => {
      const previous = versions[index - 1];
      const kind: ChangelogKind = !previous
        ? 'first'
        : majorOf(previous.version) === majorOf(entry.version)
          ? 'minor'
          : 'major';
      return { ...entry, anchor: methodVersionAnchor(entry.version), kind, current: index === versions.length - 1 };
    })
    .reverse();
}

/** The first `visible` entries to show open, and the rest to fold away. */
export function foldAfter<T>(entries: readonly T[], visible: number): { shown: T[]; folded: T[] } {
  return { shown: entries.slice(0, visible), folded: entries.slice(visible) };
}

/** "2.0" and "1.1": the next major and minor steps from a version, for the version rules. */
export function nextVersions(version: MethodVersion): { major: string; minor: string } {
  const [major, minor] = version.split('.').map(Number);
  return { major: `${major + 1}.0`, minor: `${major}.${minor + 1}` };
}

/**
 * What a version did to the scores already published. The first version
 * reads the scored-review count, because "none moved" is only true of scores
 * that exist; later ones count the re-scores they caused.
 */
export function publishedScoresEffect(
  entry: ChangelogEntry,
  scoredReviews: number,
  scoreChanges: readonly ScoreChange[],
): string {
  switch (entry.kind) {
    case 'first': {
      if (scoredReviews === 0) {
        return `No scores were published before this version. Every score from now on carries ${methodLabel(entry.version)}.`;
      }
      if (scoreChanges.length === 0) {
        return 'None moved. Reviews published before this date were scored the same way: this version wrote the method down, it did not change it.';
      }
      return `None moved by this version. Every score change since, ${scoreChanges.length} so far, is listed with its reason in the score-change log below.`;
    }
    case 'major': {
      const rescored = scoreChanges.filter((change) => change.cause === 'method' && change.methodVersion === entry.version).length;
      return `Kept at their old version until each review is re-checked. ${rescored} re-scored so far, each listed in the score-change log below with its old score.`;
    }
    case 'minor':
      return 'None moved.';
  }
}

// --- Score changes -----------------------------------------------------------

/** Score changes shown before the rest fold into a disclosure. */
export const SCORE_CHANGES_VISIBLE = 4;

/** "since Method v1.0", "1 change since Method v1.0", "14 changes since Method v1.0". */
export function scoreChangeCountLabel(count: number, firstVersion: MethodVersion = METHOD_VERSIONS[0].version): string {
  const since = `since ${methodLabel(firstVersion)}`;
  if (count === 0) return since;
  return `${count} ${count === 1 ? 'change' : 'changes'} ${since}`;
}

/** The log's "Why" cell: what moved the score, then the reason. */
export function scoreChangeWhy(change: ScoreChange): string {
  switch (change.cause) {
    case 'retest':
      return `Re-checked: ${change.reason}`;
    case 'method':
      return `Re-scored under ${methodLabel(change.methodVersion)}: ${change.reason}`;
    case 'correction':
      return `Correction: ${change.reason}`;
  }
}

/**
 * The page's "Last updated" day: its newest changelog entry or score change,
 * whichever is later, so the hero never predates what the page shows.
 */
export function methodologyUpdated(
  versions: readonly MethodVersionEntry[] = METHOD_VERSIONS,
  changes: readonly ScoreChange[] = [],
): string {
  return [...versions.map((entry) => entry.date), ...changes.map((change) => change.date)].sort().at(-1)!;
}

/**
 * A YYYY-MM-DD day as a Date at noon UTC, which formats as the same calendar
 * day in every timezone a build or a reader is likely to be in.
 */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}
