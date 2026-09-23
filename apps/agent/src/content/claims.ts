// What a page is allowed to say a number is, and what it is allowed to rest a
// badge on.
//
// Every headline figure on a launch-window page belongs to one of three tiers,
// and the tier is derived here rather than asserted by the writer: we measured
// it, somebody independent measured it, or the maker claims it and nobody has
// checked. The label is the whole point. Repeating an unverified maker figure
// as if it were a tested finding is the ACCC exposure - per Trivago, a site is
// liable for the impression its own presentation creates - and a launch page
// built on restated spec sheets is what Google's reviews guidance demotes.
//
// The two hard rules at the foot are coded rather than prompted, because a
// rule a model is asked to follow is a rule that fails silently.
import type { MeasuredClaim } from '../pipeline/types.js';

/**
 * The tiers, strongest first.
 *
 * 'context' is the fourth and is not a claim about the product at all: a brand
 * satisfaction survey or an aggregated star rating says something about a
 * brand or a corpus, and is shown as context beside the measured figures
 * rather than as one of them.
 */
export const CLAIM_TIERS = ['measured', 'independent', 'manufacturer', 'context'] as const;

export type ClaimTier = (typeof CLAIM_TIERS)[number];

/** Our own byline, in the forms it gets written. */
const OUR_NAMES = new Set(['sleekdrops', 'sleekdrops editorial team', 'sleekdrops editorial', 'us', 'we']);

/** Whether this measurement is ours - the only route to the top tier. */
export function isUs(name: string | null | undefined): boolean {
  return OUR_NAMES.has((name ?? '').trim().toLowerCase());
}

/**
 * Raters whose published result covers a brand or a tested cohort, never every
 * model carrying that brand's name.
 *
 * Canstar Blue's stars come off a commissioned satisfaction panel answering
 * about a brand, so they say nothing about a handset released last month.
 * CHOICE's score covers the models CHOICE actually put through the lab. Either
 * one attached to a model it does not cover is a rating presented as evidence
 * about something it never measured, which is the specific misrepresentation
 * the Trivago penalty was about.
 */
export const COHORT_RATERS: ReadonlyArray<{
  rater: string;
  hosts: readonly string[];
  covers: string;
  /**
   * Whether this rater puts individual models through a published test
   * protocol. CHOICE does - its score comes off an ICRT lab bench - so a
   * CHOICE result whose own coverage names the model on the page is a
   * measurement of that model, and calling it "context, not a measurement"
   * would understate the best independent evidence a launch piece can get.
   * Canstar Blue never does: the stars are a commissioned satisfaction panel
   * answering about a brand, so no coverage line can make them a test result.
   */
  testsModels: boolean;
}> = [
  {
    rater: 'Canstar Blue',
    hosts: ['canstarblue.com.au'],
    covers: 'a brand-level satisfaction survey, never a single model',
    testsModels: false,
  },
  {
    rater: 'CHOICE',
    hosts: ['choice.com.au'],
    covers: 'only the models in the cohort CHOICE tested',
    testsModels: true,
  },
];

const host = (url: string | null | undefined): string => {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

/** Which cohort rater this attribution or URL belongs to, if any. */
export function cohortRaterFor(
  attribution: string | null | undefined,
  url?: string | null,
): (typeof COHORT_RATERS)[number] | null {
  const named = (attribution ?? '').trim().toLowerCase();
  const hostname = host(url);
  return (
    COHORT_RATERS.find(
      (rater) => namesRater(named, rater.rater) || hostsRater(hostname, rater.hosts),
    ) ?? null
  );
}

/**
 * Whether an attribution names this rater.
 *
 * Anchored at the start rather than matched anywhere in the string: "CHOICE"
 * and "Canstar Blue" are prefixes of the real attributions ("CHOICE
 * Australia", "Canstar Blue 2026 survey"), and a bare substring test would
 * also catch an unrelated outlet with "choice" in its name and fail the whole
 * article over it.
 */
function namesRater(named: string, rater: string): boolean {
  const name = rater.toLowerCase();
  return named.startsWith(name) && /^[^a-z0-9]?$/.test(named.slice(name.length, name.length + 1));
}

function hostsRater(hostname: string, hosts: readonly string[]): boolean {
  return hostname !== '' && hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/** Whether `covers` actually names this subject. */
function coversSubject(covers: string | null | undefined, subject: string | null | undefined): boolean {
  const stated = (covers ?? '').toLowerCase();
  const named = (subject ?? '').trim().toLowerCase();
  return named !== '' && stated.includes(named);
}

/**
 * Which tier a figure sits in, derived from who produced it.
 *
 * A cohort rater's figure is context by default: it is a rating about a brand
 * or a cohort, and promoting it to a measurement of the model on the page is
 * exactly the rule below that refuses to ship. The one exception is the case
 * where the rater does bench models and its own coverage names this one - a
 * CHOICE ICRT lab result on the model the page is about is an independent
 * measurement, and labelling it "not a measurement of this model" would be the
 * mirror image of the error the tiers exist to prevent. A brand survey has no
 * such exception: nothing it can say about its coverage makes it a test.
 */
export function claimTier(claim: {
  subject?: string | null;
  measuredValue: string | null;
  measuredBy: string | null;
  measuredSourceUrl?: string | null;
  ownTest?: boolean;
  covers?: string | null;
}): ClaimTier {
  if (claim.measuredValue === null) return 'manufacturer';
  if (claim.ownTest === true && isUs(claim.measuredBy)) return 'measured';
  const rater = cohortRaterFor(claim.measuredBy, claim.measuredSourceUrl);
  if (rater === null) return 'independent';
  return rater.testsModels && coversSubject(claim.covers, claim.subject) ? 'independent' : 'context';
}

/** The tiers a "best of" badge may rest on: somebody measured the thing. */
const BADGE_TIERS = new Set<ClaimTier>(['measured', 'independent']);

/**
 * A claim as it reaches the page.
 *
 * One row per figure, carrying whichever side of it is load-bearing plus the
 * other side where the two disagree. `value` is always the figure the page
 * leads with at this tier, and `claimed` is the maker's number kept beside it -
 * never dropped, because the reader arrived having already seen it, and never
 * merged into `value`, because that is the laundering the tier labels exist to
 * prevent.
 */
export interface PageClaim {
  subject: string;
  /** The /go/ slug of the pick this figure is about, when it is about a pick. */
  goSlug?: string;
  metric: string;
  tier: ClaimTier;
  value: string;
  /** Who produced `value`: an outlet, the brand, or us. */
  attribution: string;
  /** The protocol `value` was measured under. */
  conditions?: string;
  /** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD', as the source published it. */
  date?: string;
  sourceUrl?: string;
  /** What the source's result actually covers - required of a cohort rater. */
  covers?: string;
  /** A figure this source has since corrected away from. */
  withdrawn?: string;
  /** The maker's figure for the same metric, when there is one to show beside it. */
  claimed?: { value: string; by: string; conditions?: string; sourceUrl?: string };
}

/** A pick as it reaches the page. */
export interface PagePick {
  name: string;
  goSlug: string;
  /** "Best overall", "Best value" - the badge the card carries, when it carries one. */
  badge?: string;
}

const clean = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * A URL a reader could actually open, or nothing.
 *
 * Dropped rather than passed through, because the frontmatter schema refuses a
 * malformed one and a schema failure fails the whole article - over a "source"
 * field that said "Apple's spec sheet". The claim is still worth printing; the
 * link is the part that is missing.
 */
const cleanUrl = (value: string | null | undefined): string | undefined => {
  const stated = clean(value);
  if (stated === undefined) return undefined;
  try {
    const parsed = new URL(stated);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? stated : undefined;
  } catch {
    return undefined;
  }
};

/** The three date shapes a source may carry; anything else is not a date. */
const SOURCE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const cleanDate = (value: string | null | undefined): string | undefined => {
  const stated = clean(value);
  return stated !== undefined && SOURCE_DATE.test(stated) ? stated : undefined;
};

/**
 * The dossier's figures, as the page will print them.
 *
 * Deterministic, and the tier is derived rather than declared: a model that
 * files a maker's number with `ownTest: true` does not get to promote it, and
 * a brand survey does not become a measurement by being filed as one.
 */
export function pageClaims(
  claims: readonly MeasuredClaim[],
  goSlugFor: (subject: string) => string | undefined = () => undefined,
): PageClaim[] {
  const page: PageClaim[] = [];
  for (const claim of claims) {
    const tier = claimTier(claim);
    const subject = claim.subject.trim();
    const metric = claim.metric.trim();
    // A figure with no subject and no metric names nothing on the page, and
    // the frontmatter schema would refuse it - which would fail the article
    // rather than drop one row.
    if (subject === '' || metric === '') continue;
    const goSlug = goSlugFor(subject);
    if (tier === 'manufacturer') {
      const value = clean(claim.claimedValue);
      // Nothing to attribute the figure to is nothing we may print: an
      // unattributed maker number read in our own voice is the exact ACCC
      // exposure this whole surface exists to remove.
      const by = clean(claim.claimedBy);
      if (value === undefined || by === undefined) continue;
      page.push({
        subject,
        ...(goSlug ? { goSlug } : {}),
        metric,
        tier,
        value,
        attribution: by,
        ...(clean(claim.claimedConditions) ? { conditions: claim.claimedConditions!.trim() } : {}),
        ...(cleanUrl(claim.claimedSourceUrl) ? { sourceUrl: cleanUrl(claim.claimedSourceUrl)! } : {}),
        ...(clean(claim.covers) ? { covers: claim.covers!.trim() } : {}),
      });
      continue;
    }
    const value = clean(claim.measuredValue);
    const by = clean(claim.measuredBy);
    if (value === undefined || by === undefined) continue;
    const claimedValue = clean(claim.claimedValue);
    const claimedBy = clean(claim.claimedBy);
    page.push({
      subject,
      ...(goSlug ? { goSlug } : {}),
      metric,
      tier,
      value,
      attribution: by,
      ...(clean(claim.conditions) ? { conditions: claim.conditions!.trim() } : {}),
      ...(cleanDate(claim.measuredOn) ? { date: cleanDate(claim.measuredOn)! } : {}),
      ...(cleanUrl(claim.measuredSourceUrl) ? { sourceUrl: cleanUrl(claim.measuredSourceUrl)! } : {}),
      ...(clean(claim.covers) ? { covers: claim.covers!.trim() } : {}),
      ...(clean(claim.withdrawnValue) ? { withdrawn: claim.withdrawnValue!.trim() } : {}),
      ...(claimedValue !== undefined && claimedBy !== undefined
        ? {
            claimed: {
              value: claimedValue,
              by: claimedBy,
              ...(clean(claim.claimedConditions) ? { conditions: claim.claimedConditions!.trim() } : {}),
              ...(cleanUrl(claim.claimedSourceUrl) ? { sourceUrl: cleanUrl(claim.claimedSourceUrl)! } : {}),
            },
          }
        : {}),
    });
  }
  return page;
}

/**
 * Which evidence chip a pick carries. Always one or the other, never blank:
 * an empty badge slot beside a filled one reads as a defect in the product
 * rather than as a fact about our evidence.
 */
export function pickEvidence(
  pick: { name: string; goSlug: string },
  claims: readonly PageClaim[],
): 'tested' | 'researched' {
  return claimsFor(pick, claims).some((claim) => claim.tier === 'measured') ? 'tested' : 'researched';
}

/** The claims a page makes about one pick. */
function claimsFor(pick: { name: string; goSlug: string }, claims: readonly PageClaim[]): PageClaim[] {
  return claims.filter(
    (claim) =>
      (claim.goSlug !== undefined && claim.goSlug === pick.goSlug) ||
      claim.subject.trim().toLowerCase() === pick.name.trim().toLowerCase(),
  );
}

/**
 * The coverage rule, in the words the researcher is handed.
 *
 * Generated from COHORT_RATERS rather than written out beside it, for the same
 * reason describeBar() is generated from EVIDENCE_BAR: the rule a model is
 * asked to follow and the rule claimProblems() enforces have to be one rule.
 * They were not. The brief asked for `covers` only where a rating was about a
 * brand or a cohort "rather than this exact model", which is an instruction to
 * leave it null on precisely the claims the check then refuses - and a refusal
 * lands at assembly, after the writing stages have been paid for.
 */
export const COVERS_RULE =
  `Every claim you attribute to ${COHORT_RATERS.map((r) => r.rater).join(' or ')} must fill "covers" with ` +
  `what that result actually covers, naming the models it covers - including when this exact model is one ` +
  `of them ("the 14 handsets CHOICE lab-tested in August 2026, including the Pixel 11 Pro"). ` +
  `${COHORT_RATERS.map((r) => `${r.rater} covers ${r.covers}`).join('; ')}. ` +
  `A cohort rating attached to a model its own coverage does not name is refused in code, so if the result ` +
  `says nothing about this model, file it as an aggregator fact and not as a claim about the product. ` +
  `The coverage line is also what separates a CHOICE lab result on this model - an independent measurement - ` +
  `from a cohort score shown only as context.`;

/**
 * The two rules that are not allowed to be advice.
 *
 * 1. A cohort rater's rating may only appear against a model its own coverage
 *    names. Without a `covers` line saying what the rating is over, there is
 *    nothing to check it against, so the claim does not ship.
 * 2. A badge is a statement that we know this pick is the best one, and the
 *    only thing that can support it is a measurement. A roundup whose picks
 *    rest on maker numbers alone fails here - and that failure is correct.
 */
export function claimProblems(claims: readonly PageClaim[], picks: readonly PagePick[]): string[] {
  const problems: string[] = [];

  for (const claim of claims) {
    const rater = cohortRaterFor(claim.attribution, claim.sourceUrl);
    if (!rater) continue;
    if (!coversSubject(claim.covers, claim.subject)) {
      problems.push(
        `claim "${claim.metric}" attributes a ${rater.rater} rating to "${claim.subject}", but ` +
          `${rater.rater} covers ${rater.covers}` +
          `${claim.covers ? ` - its stated coverage is "${claim.covers}"` : ' and this claim states no coverage'}. ` +
          `A rating is never evidence about a model it does not cover.`,
      );
    }
  }

  for (const pick of picks) {
    if (!pick.badge?.trim()) continue;
    const mine = claimsFor(pick, claims);
    if (!mine.some((claim) => BADGE_TIERS.has(claim.tier))) {
      problems.push(
        `pick "${pick.name}" carries the badge "${pick.badge}" with nothing measured behind it ` +
          `(${mine.length} claim(s), none of them measured by us or by an independent tester). ` +
          `A badge never rests on a manufacturer claim alone.`,
      );
    }
  }

  return problems;
}
