/**
 * The reader's view of where each number on a page came from.
 *
 * Everything here is a pure transform of frontmatter the agent's assembler
 * wrote (apps/agent/src/content/claims.ts), so what a reader is shown beside a
 * figure is what the research actually filed. Three rules shape all of it:
 *
 *  - A figure is labelled by who produced it, never by how confident the
 *    sentence around it sounds. Repeating a maker's number as a tested finding
 *    is the exposure - per Trivago, a site is liable for the impression its own
 *    presentation creates - and the label is what removes it.
 *  - The maker's figure is never dropped. The reader arrived having already
 *    seen it on the box; a page without it reads as one that missed the spec,
 *    and the gap between claimed and measured is usually the most useful thing
 *    on the page.
 *  - Nothing is inferred. A claim with no measurement says nobody has measured
 *    it, a launch window that has closed says so, and a post carrying none of
 *    these fields renders exactly as it did before they existed.
 *
 * Explicit .ts extensions: this module is loaded directly by the node --test
 * runner (see evidence.test.ts), which needs real specifiers.
 */

import type { ClaimData, ClaimTier, LaunchData, ReviewUnitData } from '../content/frontmatter.ts';
import { formatSourceDate } from './sources.ts';

/**
 * The tiers, strongest first - the order the page groups them in, and the
 * order the methodology page documents.
 */
export const CLAIM_TIER_ORDER: ClaimTier[] = ['measured', 'independent', 'manufacturer', 'context'];

/** What each tier is called where it is grouped. */
export const CLAIM_TIER_HEADINGS: Record<ClaimTier, string> = {
  measured: 'We measured it',
  independent: 'Independently measured',
  manufacturer: 'Manufacturer claim',
  context: 'Context, not a measurement',
};

/** The short chip beside a single figure. */
export const CLAIM_TIER_CHIPS: Record<ClaimTier, string> = {
  measured: 'We measured it',
  independent: 'Independently measured',
  manufacturer: 'Manufacturer claim',
  context: 'Context',
};

/**
 * What each tier means, in the reader's words rather than ours. The weakest
 * tier is named for what has not happened to it rather than for a verdict on
 * the product: "not independently verified" is checkable, "unreliable" is an
 * accusation we have no grounds for.
 */
export const CLAIM_TIER_MEANINGS: Record<ClaimTier, string> = {
  measured: 'We ran this test ourselves and published the conditions.',
  independent: 'Measured by a tester who publishes the protocol behind the number.',
  manufacturer: 'The maker states this figure. Nobody independent has verified it.',
  context: 'A rating about a brand or a tested group, not a measurement of this model.',
};

/** How long after release a product counts as newly launched - eight weeks. */
export const LAUNCH_WINDOW_DAYS = 56;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The gap at which a claimed and a measured figure are reported as disagreeing. */
export const VARIANCE_THRESHOLD = 0.1;

/** One claim, with everything the page needs to print it already resolved. */
export interface ClaimEntry extends ClaimData {
  /** 'We measured it', 'Manufacturer claim' - the chip beside the figure. */
  chip: string;
  /** The full attribution line: who, what, and when. */
  attributionLine: string;
  /** The source's own date, at its published precision. Null when undated. */
  dateLabel: string | null;
  /** The signed gap between the maker's figure and the measured one, when both parse. */
  variance: number | null;
  /** True when the gap clears the published threshold and is worth printing. */
  varianceShown: boolean;
}

/**
 * The attribution line under a figure, built from the tier.
 *
 * Each tier says a different thing, and all three say who: "Independently
 * measured by GSMArena, battery life screen-on, September 2026" is checkable,
 * "tested battery life" is a claim about us that nobody can check.
 */
export function attributionLine(claim: ClaimData): string {
  const date = formatSourceDate(claim.date);
  switch (claim.tier) {
    case 'measured':
      return `We measured it${claim.conditions ? ` - ${claim.conditions}` : ''}${date ? `, ${date}` : ''}`;
    case 'independent':
      return `Independently measured by ${claim.attribution}, ${claim.metric.toLowerCase()}${date ? `, ${date}` : ''}`;
    case 'manufacturer':
      return `${claim.attribution} claim, not independently verified`;
    case 'context':
      // What it covers is the important half and gets its own line beside the
      // figure, so repeating it here would print the same sentence twice.
      return `${claim.attribution} rating${date ? `, ${date}` : ''}`;
  }
}

/** The leading figure in a value, and the unit it is stated in. */
function figure(value: string): { amount: number; unit: string } | null {
  const match = /(-?\d[\d,]*(?:\.\d+)?)\s*([^\d\s,]*[a-z]*)/i.exec(value);
  if (match === null) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount === 0) return null;
  return { amount, unit: normaliseUnit(match[2]) };
}

/** Units a reader treats as the same unit. Anything unrecognised compares as itself. */
function normaliseUnit(unit: string): string {
  const cleaned = unit.trim().toLowerCase().replace(/[.,]/g, '');
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(cleaned)) return 'h';
  if (['min', 'mins', 'minute', 'minutes'].includes(cleaned)) return 'min';
  if (['nit', 'nits', 'cd/m2', 'cd/m²'].includes(cleaned)) return 'nits';
  return cleaned;
}

/**
 * How far a measured figure sits from the maker's, as a signed fraction.
 *
 * Null unless both sides parse into the same unit: "50 hrs" against "31 hours"
 * is a comparison, "50 hrs" against "A+" is two different things next to each
 * other, and printing a percentage over the second would be inventing a
 * finding.
 */
export function variance(claimed: string, measured: string): number | null {
  const from = figure(claimed);
  const to = figure(measured);
  if (from === null || to === null || from.unit !== to.unit) return null;
  return (to.amount - from.amount) / Math.abs(from.amount);
}

/** The gap as a reader reads it: "-38%". */
export function varianceLabel(gap: number): string {
  const percent = Math.round(gap * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/**
 * The claims a page makes, resolved for rendering and grouped strongest first.
 *
 * The variance is only marked as shown past a threshold this site publishes,
 * so a two-percent difference between two honest test methods does not read as
 * an accusation.
 */
export function toClaimEntries(claims: readonly ClaimData[] = []): ClaimEntry[] {
  return claims.map((claim) => {
    const gap = claim.claimed ? variance(claim.claimed.value, claim.value) : null;
    return {
      ...claim,
      chip: CLAIM_TIER_CHIPS[claim.tier],
      attributionLine: attributionLine(claim),
      dateLabel: formatSourceDate(claim.date),
      variance: gap,
      varianceShown: gap !== null && Math.abs(gap) >= VARIANCE_THRESHOLD,
    };
  });
}

/** The claims of one tier, in the order the research filed them. */
export function claimsByTier(entries: readonly ClaimEntry[], tier: ClaimTier): ClaimEntry[] {
  return entries.filter((entry) => entry.tier === tier);
}

/** The tiers this page actually uses, strongest first. Empty tiers are not drawn. */
export function tiersPresent(entries: readonly ClaimEntry[]): ClaimTier[] {
  return CLAIM_TIER_ORDER.filter((tier) => entries.some((entry) => entry.tier === tier));
}

/** Where a product is in its launch window. */
export type LaunchState = 'awaiting' | 'first-result' | 'closed';

export interface LaunchStatus {
  state: LaunchState;
  releaseDate: Date;
  /** Negative before release: a pre-order piece is inside the window too. */
  daysSinceRelease: number;
  /** The day the window closes - the date the promise of an update is made against. */
  windowEnds: Date;
  /** True while the product is inside its launch window. */
  open: boolean;
  /** Everyone who has measured something, us included. */
  measuredBy: string[];
  /** The outlets other than us who have measured something - who the notice names. */
  independentBy: string[];
}

/**
 * Whether a launch piece is still waiting on an independent result.
 *
 * Derived from the date and the claims rather than stored, because a stored
 * "no independent test exists yet" is true on the day it is written and a lie
 * three months later - and the page is the thing a reader checks, not the
 * frontmatter.
 *
 * Our own test does not close the wait. The notice's subject is whether anyone
 * outside this masthead has published a measured figure, so a page carrying
 * only our own run is still awaiting one - saying otherwise would name us as
 * the independent result, which is the one thing we cannot be.
 */
export function launchStatus(
  launch: LaunchData,
  claims: readonly ClaimData[] = [],
  now: Date = new Date(),
): LaunchStatus {
  const releaseDate = new Date(`${launch.releaseDate}T00:00:00Z`);
  const daysSinceRelease = Math.floor((now.getTime() - releaseDate.getTime()) / DAY_MS);
  const windowEnds = new Date(releaseDate.getTime() + LAUNCH_WINDOW_DAYS * DAY_MS);
  const open = daysSinceRelease <= LAUNCH_WINDOW_DAYS;
  const namesOf = (tiers: readonly ClaimTier[]): string[] => [
    ...new Set(
      claims.filter((claim) => tiers.includes(claim.tier)).map((claim) => claim.attribution),
    ),
  ];
  const measuredBy = namesOf(['measured', 'independent']);
  const independentBy = namesOf(['independent']);
  return {
    state: !open ? 'closed' : independentBy.length > 0 ? 'first-result' : 'awaiting',
    releaseDate,
    daysSinceRelease,
    windowEnds,
    open,
    measuredBy,
    independentBy,
  };
}

/** What the review-unit block says, generated rather than hand-written. */
export interface ProvenanceCopy {
  /** The uppercase label on the block. */
  label: string;
  /** The fact itself, in one short sentence - the part the block emphasises. */
  lead: string;
  /** What follows from it: what we paid, what happened to the unit, who had a say. */
  detail: string;
  /** The independence line that closes it - the same promise in every state. */
  independence: string;
  /** Which of the three treatments the block wears. */
  variant: 'retail' | 'loan' | 'desk';
}

/**
 * How we got the unit, in the shape the ACCC's standard actually asks for:
 * who supplied it, what the benefit was, and what happened to it afterwards.
 *
 * "Supplied for review" is deliberately not one of the outputs. It names
 * nobody and leaves the reader guessing whether the unit was kept, which is
 * the family of vague labels the ACCC's influencer sweep singled out.
 *
 * `measuredOurselves` is what the page's own claims say, because the block may
 * not contradict them. "Nothing on this page is measured by us" printed above
 * a figure labelled "We measured it" is the page arguing with itself, and the
 * reader has no way to tell which half to believe.
 */
export function provenanceCopy(
  unit: ReviewUnitData,
  measuredOurselves = false,
): ProvenanceCopy {
  const independence =
    'No brand pays for a place here, no brand sees a piece before it runs, and nobody outside this masthead had any input into what it says.';
  if (unit.acquisition === 'retail') {
    return {
      label: 'How we got this unit',
      lead: `We bought this unit at retail${unit.paid ? ` for ${unit.paid}` : ''}.`,
      detail: 'It was not supplied, discounted or arranged by the brand.',
      independence,
      variant: 'retail',
    };
  }
  if (unit.acquisition === 'loan') {
    const supplier = unit.supplier ?? 'the brand';
    const returned = formatSourceDate(unit.returned);
    return {
      label: 'How we got this unit',
      lead: `${supplier} lent us this unit for testing.`,
      detail:
        `${returned ? `We returned it in ${returned}. ` : ''}We paid nothing for it, and ${supplier} had no input into this page.`,
      independence,
      variant: 'loan',
    };
  }
  return {
    label: 'How we got this unit',
    lead: 'We were not sent a unit and did not buy one.',
    detail: measuredOurselves
      ? 'Where a figure below is ours it says so, and every other one is labelled with the tester who measured it, or with the maker who claims it.'
      : 'Nothing on this page is measured by us. Every figure below is labelled with who did measure it, or with the maker who claims it.',
    independence,
    variant: 'desk',
  };
}

/** Which state the evidence panel is in - the thing a reader is actually looking at. */
export type EvidenceState = 'default' | 'no-independent-test' | 'corrected' | 'legacy';

/**
 * What the evidence panel has to say about itself.
 *
 * 'legacy' is the important one: a post carrying no claims and no measured
 * sources is not a post with weak evidence, it is a post written before any of
 * this was recorded. It renders as it always did rather than growing an empty
 * panel that implies something is missing.
 */
export function evidenceState(
  entries: readonly ClaimEntry[],
  sources: ReadonlyArray<{ measured?: string; withdrawn?: string }> = [],
): EvidenceState {
  if (entries.length === 0 && !sources.some((source) => source.measured)) return 'legacy';
  if (entries.some((entry) => entry.withdrawn) || sources.some((source) => source.withdrawn)) {
    return 'corrected';
  }
  return entries.some((entry) => entry.tier === 'measured' || entry.tier === 'independent')
    ? 'default'
    : 'no-independent-test';
}

/** "GSMArena and Notebookcheck" - a list a sentence can contain. */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "3 of 9 sources shown" - the count that has to match what is on screen. */
export function shownOfLabel(shown: number, total: number): string {
  return shown === total
    ? `${total} ${total === 1 ? 'source' : 'sources'}`
    : `${shown} of ${total} ${total === 1 ? 'source' : 'sources'} shown`;
}
