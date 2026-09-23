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

import type {
  ClaimData,
  ClaimTier,
  LaunchData,
  ReviewUnitData,
  SourceData,
} from '../content/frontmatter.ts';
import { displayUrl, formatSourceDate } from './sources.ts';

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

/** The threshold as the page prints it, so the copy and the maths are one number. */
export const VARIANCE_THRESHOLD_LABEL = `${Math.round(VARIANCE_THRESHOLD * 100)}%`;

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
  /** True when this row is a maker's figure set against a measurement of the same thing. */
  comparison: boolean;
}

/**
 * Whether a row's two figures may be printed against each other.
 *
 * Only where the second one is a measurement. The side-by-side card heads its
 * right-hand column "Measured", so a brand or cohort rating printed there is a
 * rating presented as a measurement of this model - the single presentation
 * this surface exists to prevent, and the one the agent's sources.ts already
 * refuses for source rows. The gap makes it worse: a maker's spec and a
 * satisfaction survey are not two readings of one quantity, so a percentage
 * between them, or a line saying neither side disputes the other's arithmetic,
 * is the page asserting a comparison it has no basis for. The maker's figure
 * still appears on those rows - attributed, and clear of the rating.
 */
export function comparesWithClaimed(claim: ClaimData): boolean {
  return (
    claim.claimed !== undefined && (claim.tier === 'measured' || claim.tier === 'independent')
  );
}

/**
 * The maker's figure on a row that has no measurement to set it against.
 *
 * Composed here rather than as fragments in the markup: the conditions are
 * optional, and an absent one interpolated between two lines of JSX leaves a
 * space sitting in front of the full stop.
 */
export function makerFigureNote(claimed: NonNullable<ClaimData['claimed']>): string {
  return (
    `${claimed.by} states ${claimed.value} for this metric` +
    `${claimed.conditions ? ` (${claimed.conditions})` : ''}. ` +
    `Nobody independent has verified it, and the figure above does not measure it.`
  );
}

/**
 * What a figure's source says its own result covers, when it says anything.
 *
 * Printed on every tier that states coverage, not only on the rating shown as
 * context. A cohort result is labelled "independently measured" exactly when
 * its coverage names this model, so the coverage line is what lets a reader
 * check that promotion - "the 12 handsets CHOICE lab-tested in August 2026,
 * including the Galaxy S26 Ultra" under a figure about the Galaxy S26 is a
 * mismatch anyone can see, and hiding the line on the promoted rows would hide
 * it exactly where it is load-bearing.
 */
export function coverageNote(claim: ClaimData): string | null {
  const covers = claim.covers?.trim();
  if (!covers) return null;
  return claim.tier === 'context'
    ? `This rating covers ${covers}. It is shown as context and is not a measurement of ${claim.subject}.`
    : `This result covers ${covers}.`;
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
 * What the gap column says when there is no percentage to print, which is two
 * different facts and never one sentence.
 *
 * A gap under the threshold means the two figures were compared and agree. A
 * null variance means they were never comparable at all - "All-day battery"
 * against a measured "6 h 10 min" has no percentage between it - and printing
 * "they agree within 10%" over that pair is the page asserting in its own
 * voice a consistency it never computed, which launders the maker's phrase as
 * consistent with a measurement. So the incomparable case says what it is.
 */
export function gapNote(entry: { variance: number | null }): string {
  return entry.variance === null
    ? 'These two figures are not directly comparable, so there is no gap to report. Each is shown above with who produced it and under what conditions.'
    : `The two figures agree within ${VARIANCE_THRESHOLD_LABEL}, so there is no gap worth reporting.`;
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
    const comparison = comparesWithClaimed(claim);
    const gap = comparison ? variance(claim.claimed!.value, claim.value) : null;
    return {
      ...claim,
      chip: CLAIM_TIER_CHIPS[claim.tier],
      attributionLine: attributionLine(claim),
      dateLabel: formatSourceDate(claim.date),
      variance: gap,
      varianceShown: gap !== null && Math.abs(gap) >= VARIANCE_THRESHOLD,
      comparison,
    };
  });
}

/**
 * Where each figure's evidence is addressed, on the page and off it.
 *
 * The citation beside a figure is the outbound link, and it names the
 * publisher it lands on: Google's review guidance rewards pointing a reader at
 * the evidence, and a label reading like a citation that silently scrolls the
 * page instead is the in-page-link failure Nielsen Norman documents - the
 * reader clicks expecting to arrive somewhere and does not.
 *
 * The in-page jump to the evidence panel stays, but as a supplement with its
 * own wording and its own styling, never as the citation. Both behaviours on
 * one page are fine; the same label doing both is not.
 */

/** The id on the evidence panel's heading - the anchor a figure falls back to. */
export const EVIDENCE_PANEL_ID = 'evidence-panel-title';

/** The evidence-panel row for a figure we measured ourselves. */
export function claimRowId(index: number): string {
  return `evidence-claim-${index + 1}`;
}

/** The evidence-panel row for one of the article's sources. */
export function sourceRowId(index: number): string {
  return `evidence-source-${index + 1}`;
}

/**
 * The panel row a figure's "How we checked" link lands on.
 *
 * Our own measurements have a row of their own; everything else is matched to
 * the source row it came from by address, ignoring the scheme, `www.` and a
 * trailing slash so two spellings of one URL are still one row. A figure whose
 * source is not in the list lands on the panel itself rather than nowhere.
 */
export function evidenceAnchor(
  claim: ClaimData,
  claimIndex: number,
  sources: readonly SourceData[] = [],
): string {
  if (claim.tier === 'measured') return `#${claimRowId(claimIndex)}`;
  if (claim.sourceUrl) {
    const wanted = displayUrl(claim.sourceUrl);
    const position = sources.findIndex((source) => displayUrl(source.url) === wanted);
    if (position >= 0) return `#${sourceRowId(position)}`;
  }
  return `#${EVIDENCE_PANEL_ID}`;
}

/**
 * What the in-page link to the panel says, which is not the same sentence for
 * every tier. "How we checked" over a figure nobody has checked would be the
 * page claiming a verification it did not do - the one thing the tier labels
 * exist to prevent - so a maker's number and a brand rating offer the reader
 * the provenance instead, which is what their rows actually hold.
 */
export function methodLinkLabel(tier: ClaimTier): string {
  return tier === 'measured' || tier === 'independent'
    ? 'How we checked'
    : 'Where this came from';
}

/**
 * The text on an outbound citation: who it lands on, and the date they put on
 * it. The date is on the link rather than only in the prose above it because a
 * launch-window reader's actual doubt is how current the figure is.
 */
export function citationLabel(publisher: string, date?: string, lead = 'Check it yourself'): string {
  const shown = formatSourceDate(date);
  return `${lead}: ${publisher}${shown ? `, ${shown}` : ''}`;
}

/** The claims of one tier, in the order the research filed them. */
export function claimsByTier(entries: readonly ClaimEntry[], tier: ClaimTier): ClaimEntry[] {
  return entries.filter((entry) => entry.tier === tier);
}

/** The tiers this page actually uses, strongest first. Empty tiers are not drawn. */
export function tiersPresent(entries: readonly ClaimEntry[]): ClaimTier[] {
  return CLAIM_TIER_ORDER.filter((tier) => entries.some((entry) => entry.tier === tier));
}

/**
 * The sentence every launch notice opens with, in the tense the release date
 * actually calls for.
 *
 * A pre-order page is inside the launch window and carries the notice, but its
 * release date has not happened yet: "went on sale on 14 October" beside a
 * "Pre-order" chip is the notice contradicting itself, on the one page whose
 * subject is getting provenance right.
 */
export function onSaleSentence(product: string, released: string, daysSinceRelease: number): string {
  return `${product} ${daysSinceRelease < 0 ? 'goes' : 'went'} on sale on ${released}.`;
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
