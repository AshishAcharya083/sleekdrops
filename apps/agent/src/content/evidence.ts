// The deterministic half of the research stage: how a raw dossier is cleaned
// up, and how much evidence a piece must carry before anyone is allowed to
// write from it.
//
// It lives apart from researcher.ts because none of it involves a model. The
// researcher gathers and synthesises; this file decides what the synthesis is
// actually worth, in code, the same way every time. Nothing here calls an LLM
// or the network, which is also what makes it testable.
import { parseAmazonUrl, slugify } from './contract.js';
import type {
  BuyerExclusion,
  ComplaintKind,
  ComplaintVolume,
  DossierFact,
  EvidenceShortfall,
  EvidenceSufficiency,
  FailureMode,
  OwnerComplaint,
  PriceObservation,
  ResearchDossier,
  SourceTier,
  TestedClaim,
} from '../pipeline/types.js';

const KNOWN_TIERS: readonly string[] = ['primary', 'expert', 'owner', 'aggregator'];
const KNOWN_VOLUMES: readonly string[] = ['isolated', 'recurring', 'widespread'];
const KNOWN_COMPLAINT_KINDS: readonly string[] = ['quoted', 'aggregate'];

/**
 * How each stratum is gathered - printed in the gate's message when it is thin.
 *
 * The named sources are the ones that actually carry Australian volume, and
 * the exclusions are as load-bearing as the inclusions. Canstar Blue is a
 * commissioned panel survey that licenses award logos to the brands it rates,
 * so it is never an owner source and never a tested claim; retailer review
 * corpora are syndicated across markets and openly incentivised, so they only
 * count once filtered down to verified, unincentivised local purchasers.
 */
const STRATUM_FIX: Record<string, string> = {
  primary:
    "the maker's own spec page or the retailer's product listing - search the model number plus \"specifications\"",
  expert:
    'independent reviewers who measured something themselves - Choice lab tests, RTINGS, teardowns. ' +
    'Canstar Blue is a paid-panel brand survey, not a test: file it as an aggregator, never as a tested claim',
  owner:
    'ProductReview.com.au, Choice member reliability surveys (brand-level, owner-assessed, sample size published), ' +
    'Whirlpool Forums and OzBargain for tech, Bunnings verified-purchase reviews for home. Retailer reviews ' +
    '(JB Hi-Fi, The Good Guys) count only when verified-purchase, unincentivised and unsyndicated',
  price: 'a named retailer listing, dated the day you actually saw the price - not the publish date',
  competing: 'read the pages currently ranking and say what they cover and where they are thin',
};

/**
 * Categories with no Australian owner corpus worth gating on. The advice was
 * blunt: ProductReview's health listings are thin, and Chemist Warehouse and
 * Priceline publish no review methodology at all. Holding a supplements guide
 * to the same owner bar as a vacuum guide would not produce owner evidence,
 * it would produce invented owner evidence or a category that never ships.
 */
const THIN_OWNER_CORPUS = new Set(['Health']);

/**
 * The evidence bar, per post type. A guide recommends things people spend
 * money on, so it carries the whole set; a plain article may legitimately be a
 * trend piece with no price and no failure history to report, and is held to
 * sourcing rather than to owner experience.
 *
 * These are minimum counts, not targets. They exist because "the model looked
 * and found nothing" and "the model did not look" produce the same thin
 * dossier, and only one of them is acceptable to publish from.
 */
export interface EvidenceBar {
  primaryFacts: number;
  expertFacts: number;
  ownerFacts: number;
  testedClaims: number;
  failureModes: number;
  /**
   * Complaints that name a source and say how many owners said it. Four
   * hand-picked quotes are weaker evidence than the aggregate fault rates the
   * category leaders publish, so an attribution and a denominator are what
   * makes one count - and one published fault rate substitutes for all four.
   */
  attributedOwnerComplaints: number;
  /**
   * Buyer exclusions that route someone somewhere: a named audience, a reason
   * with substance, and a source behind it. One is the floor. A hard bar of
   * two on a product that genuinely has one exclusion does not produce a
   * second exclusion, it produces "not for everyone" - padding that reads
   * templated and, worse, states something about the product nobody checked.
   */
  groundedExclusions: number;
  /** Price observations carrying a date. An undated price is not evidence. */
  datedPriceObservations: number;
  /** 0 or 1 - whether the competing-coverage read happened at all. */
  competingCoverage: number;
}

export const EVIDENCE_BAR: Record<string, EvidenceBar> = {
  guide: {
    primaryFacts: 4,
    expertFacts: 3,
    ownerFacts: 3,
    testedClaims: 2,
    failureModes: 3,
    attributedOwnerComplaints: 4,
    groundedExclusions: 1,
    datedPriceObservations: 3,
    competingCoverage: 1,
  },
  roundup: {
    primaryFacts: 3,
    expertFacts: 2,
    ownerFacts: 3,
    testedClaims: 1,
    failureModes: 2,
    attributedOwnerComplaints: 3,
    groundedExclusions: 1,
    datedPriceObservations: 3,
    competingCoverage: 1,
  },
  // No owner-experience floor, deliberately. A trend piece about a product
  // announced last week has no owners to complain, and failing it on that
  // would block the one post type that is legitimately written before anyone
  // has bought the thing. Its floor is sourcing depth instead.
  article: {
    primaryFacts: 4,
    expertFacts: 2,
    ownerFacts: 0,
    testedClaims: 0,
    failureModes: 0,
    attributedOwnerComplaints: 0,
    groundedExclusions: 0,
    datedPriceObservations: 0,
    competingCoverage: 1,
  },
};

/** The owner floor for a category where no Australian owner corpus exists. */
const THIN_OWNER_BAR = { ownerFacts: 1, failureModes: 1, attributedOwnerComplaints: 1 };

/**
 * The bar this piece is held to. An unrecognised post type is held to the
 * article bar, never to nothing; a category with no owner corpus keeps a
 * floor rather than the full owner set, so the honest answer there is a small
 * sample disclosed, not a fabricated one.
 */
export function barFor(postType: string, category?: string): EvidenceBar {
  const bar = EVIDENCE_BAR[postType] ?? EVIDENCE_BAR.article;
  if (category === undefined || !THIN_OWNER_CORPUS.has(category)) return bar;
  return {
    ...bar,
    ownerFacts: Math.min(bar.ownerFacts, THIN_OWNER_BAR.ownerFacts),
    failureModes: Math.min(bar.failureModes, THIN_OWNER_BAR.failureModes),
    attributedOwnerComplaints: Math.min(
      bar.attributedOwnerComplaints,
      THIN_OWNER_BAR.attributedOwnerComplaints,
    ),
  };
}

/** Which count each bar entry reads, and how it is named to an operator. */
const STRATUM_OF: Record<keyof EvidenceBar, { stratum: string; label: string }> = {
  primaryFacts: { stratum: 'primary', label: 'facts from a primary source' },
  expertFacts: { stratum: 'expert', label: 'facts from independent expert reviews' },
  ownerFacts: { stratum: 'owner', label: 'facts from owner reviews' },
  testedClaims: { stratum: 'expert', label: 'attributed tested claims' },
  failureModes: { stratum: 'owner', label: 'failure modes' },
  attributedOwnerComplaints: {
    stratum: 'owner',
    label: 'owner complaints with a named source and a denominator',
  },
  groundedExclusions: { stratum: 'owner', label: 'sourced buyer exclusions' },
  datedPriceObservations: { stratum: 'price', label: 'dated price observations' },
  competingCoverage: { stratum: 'competing', label: 'competing-coverage read' },
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A tier we recognise, or 'unknown'. Never a silent promotion to 'primary'. */
export function normaliseTier(value: unknown): SourceTier {
  const tier = text(value).toLowerCase();
  return KNOWN_TIERS.includes(tier) ? (tier as SourceTier) : 'unknown';
}

function normaliseVolume(value: unknown): ComplaintVolume {
  const volume = text(value).toLowerCase();
  return KNOWN_VOLUMES.includes(volume) ? (volume as ComplaintVolume) : 'unknown';
}

/**
 * A published fault rate over a stated sample, or individual owner reports.
 * Anything we cannot place is 'quoted': the substitution rule only ever fires
 * on a complaint that explicitly claims to be an aggregate.
 */
function normaliseComplaintKind(value: unknown): ComplaintKind {
  const kind = text(value).toLowerCase();
  return KNOWN_COMPLAINT_KINDS.includes(kind) ? (kind as ComplaintKind) : 'quoted';
}

/**
 * A date the way a source gives one: a year, a month, or a day. Anything else
 * - "recently", "last year", an empty string - is undated, and says so.
 */
export function normaliseDate(value: unknown): string | null {
  const raw = text(value).split('T')[0];
  // Unpadded is accepted and padded, not discarded: a model that writes
  // "2026-9-1" gave us the date, and dropping it costs a price observation
  // its place in the gate's count for a formatting slip.
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(year) < 1900) return null;
  if (month === undefined) return year;
  if (Number(month) < 1 || Number(month) > 12) return null;
  const yearMonth = `${year}-${month.padStart(2, '0')}`;
  if (day === undefined) return yearMonth;
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${yearMonth}-${day.padStart(2, '0')}`;
}

/**
 * A price as a number, from "A$1,299.00" or 1299 alike. Null when unusable.
 *
 * The first figure in the string, not every digit in it: stripping the
 * punctuation out of a range ("$1,299 - $1,499") silently concatenates the two
 * into $12,991,499, which is a number, passes every check, and is nonsense on
 * the page. The low end of a range is the honest reading of one.
 */
function normalisePrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const figure = /\d[\d,]*(?:\.\d+)?/.exec(text(value));
  const numeric = figure === null ? NaN : Number(figure[0].replace(/,/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normaliseCurrency(value: unknown): string {
  const code = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'unknown';
}

function normaliseYear(value: unknown): number | null {
  const year = typeof value === 'number' ? value : Number(text(value));
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Turn whatever the model returned into a dossier the rest of the pipeline can
 * rely on: every stratum an array, every fact tiered and dated (or explicitly
 * marked as neither), every product slug normalised and every claimed Amazon
 * URL parsed before it is believed.
 *
 * The Amazon rule is the one that costs money when it slips. A retailer or
 * news URL the model called an amazonUrl is dropped here, deterministically,
 * with a note on the product saying so - that is the gate keeping non-Amazon
 * links out of the affiliate table, and it behaves exactly as it always has.
 */
export function normaliseDossier(raw: unknown): ResearchDossier {
  const d = asRecord(raw);

  const facts: DossierFact[] = asArray(d.facts)
    .map((entry) => {
      const f = asRecord(entry);
      return {
        fact: text(f.fact),
        sourceUrl: text(f.sourceUrl),
        tier: normaliseTier(f.tier),
        date: normaliseDate(f.date),
        publisher: text(f.publisher) || null,
      };
    })
    .filter((f) => f.fact !== '');

  const products = asArray(d.products)
    .map((entry) => {
      const p = asRecord(entry);
      const product = {
        name: text(p.name),
        brand: text(p.brand),
        approxPrice: text(p.approxPrice),
        amazonUrl: text(p.amazonUrl) || null,
        goSlug: slugify(text(p.goSlug) || text(p.name)),
        notes: text(p.notes),
      };
      if (product.amazonUrl && !parseAmazonUrl(product.amazonUrl)) {
        product.notes = `${product.notes} [non-Amazon URL dropped: ${product.amazonUrl}]`.trim();
        product.amazonUrl = null;
      }
      return product;
    })
    .filter((p) => p.name !== '');

  const failureModes: FailureMode[] = asArray(d.failureModes)
    .map((entry) => {
      const f = asRecord(entry);
      return {
        product: text(f.product),
        failure: text(f.failure),
        timeframe: text(f.timeframe),
        sourceUrl: text(f.sourceUrl),
        tier: normaliseTier(f.tier),
      };
    })
    .filter((f) => f.failure !== '');

  const whoShouldNotBuy: BuyerExclusion[] = asArray(d.whoShouldNotBuy)
    .map((entry) => {
      const w = asRecord(entry);
      return {
        audience: text(w.audience),
        reason: text(w.reason),
        sourceUrl: text(w.sourceUrl),
      };
    })
    .filter((w) => w.audience !== '' && w.reason !== '');

  const ownerComplaints: OwnerComplaint[] = asArray(d.ownerComplaints)
    .map((entry) => {
      const c = asRecord(entry);
      return {
        product: text(c.product),
        complaint: text(c.complaint),
        volume: normaliseVolume(c.volume),
        recency: normaliseDate(c.recency),
        denominator: text(c.denominator) || null,
        kind: normaliseComplaintKind(c.kind),
        sourceUrl: text(c.sourceUrl),
      };
    })
    .filter((c) => c.complaint !== '');

  const priceObservations: PriceObservation[] = asArray(d.priceObservations)
    .map((entry) => {
      const o = asRecord(entry);
      return {
        product: text(o.product),
        value: normalisePrice(o.value) ?? 0,
        currency: normaliseCurrency(o.currency),
        retailer: text(o.retailer),
        dateChecked: normaliseDate(o.dateChecked),
        sourceUrl: text(o.sourceUrl),
      };
    })
    .filter((o) => o.value > 0 && o.retailer !== '');

  const testedClaims: TestedClaim[] = asArray(d.testedClaims)
    .map((entry) => {
      const t = asRecord(entry);
      return {
        claim: text(t.claim),
        source: text(t.source),
        year: normaliseYear(t.year),
        sourceUrl: text(t.sourceUrl),
      };
    })
    .filter((t) => t.claim !== '' && t.source !== '');

  const keywords = asRecord(d.keywords);
  return {
    summary: text(d.summary),
    facts,
    products,
    failureModes,
    whoShouldNotBuy,
    ownerComplaints,
    priceObservations,
    testedClaims,
    keywords: {
      primary: text(keywords.primary),
      secondary: asArray(keywords.secondary).map(text).filter(Boolean),
    },
    competitorNotes: text(d.competitorNotes),
    faqIdeas: asArray(d.faqIdeas)
      .map((entry) => {
        const f = asRecord(entry);
        return { question: text(f.question), answerHint: text(f.answerHint) };
      })
      .filter((f) => f.question !== ''),
  };
}

/**
 * Shortest competitorNotes that could describe what the top pages cover and
 * where they are thin. Below it the stratum was skipped, whatever it says.
 */
const MEANINGFUL_NOTES_CHARS = 40;

/** Shortest reason that can route a buyer anywhere. */
const MEANINGFUL_REASON_CHARS = 30;

/**
 * Exclusions that exclude nobody. These are what a quota produces on a product
 * that genuinely has one thing wrong with it, and they are the templated
 * reading in miniature - every guide on the site ending with the same shrug.
 */
const GENERIC_EXCLUSION =
  /^(?:anyone |people |buyers? |shoppers? )?(?:who |on |wanting |looking for )?(?:not for )?(?:everyone|everybody|beginners?|the cheapest option|a tight budget|a budget|budget buyers?|bargain hunters?|casual users?)$/i;

/** A reason that is only "it costs money", which is true of every product. */
const PRICE_ONLY_REASON = /^(?:it(?:'s| is)? )?(?:too )?(?:expensive|pricey|costly|dear)\.?$/i;

/**
 * Whether a source actually gave a date. A missing field counts as undated the
 * same way an explicit null does - the two are the same evidence.
 */
const dated = (value: string | null | undefined): boolean => typeof value === 'string' && value !== '';

/** A URL we could actually put in front of a reader. */
const sourced = (url: unknown): boolean => /^https?:\/\/\S+$/i.test(text(url));

/**
 * A complaint that carries its own evidence: a source a reader can open, and
 * a denominator saying how much of the owner corpus it speaks for ("37 of 412
 * reviews", "1,076 owners surveyed"). Without both it is an anecdote someone
 * picked, which is exactly the credibility problem a no-sponsored-posts site
 * cannot afford.
 */
const attributed = (complaint: OwnerComplaint): boolean =>
  sourced(complaint.sourceUrl) && text(complaint.denominator) !== '';

/**
 * A published fault rate: an aggregate over a stated sample with a field
 * window. One of these is stronger evidence than four quotes and stands in
 * for them, which is how the category leaders actually report owner
 * experience.
 */
const aggregateFaultRate = (complaint: OwnerComplaint): boolean =>
  complaint.kind === 'aggregate' && attributed(complaint) && dated(complaint.recency);

/** An exclusion that names someone, says something, and can be traced. */
const grounded = (exclusion: BuyerExclusion): boolean => {
  const audience = text(exclusion.audience);
  const reason = text(exclusion.reason);
  return (
    audience !== '' &&
    !GENERIC_EXCLUSION.test(audience) &&
    !PRICE_ONLY_REASON.test(reason) &&
    reason.length >= MEANINGFUL_REASON_CHARS &&
    sourced(exclusion.sourceUrl)
  );
};

/** Every measurable quantity in a dossier, counted once. */
export function countEvidence(dossier: ResearchDossier): Record<string, number> {
  const facts = dossier.facts ?? [];
  const byTier = (tier: SourceTier): number => facts.filter((f) => f.tier === tier).length;
  // Anything the normaliser did not place, plus facts from dossiers written
  // before tiering existed - both are untiered, and neither is a stratum.
  const untiered = facts.filter((f) => !KNOWN_TIERS.includes(f.tier)).length;
  const priceObservations = dossier.priceObservations ?? [];
  const ownerComplaints = dossier.ownerComplaints ?? [];
  const exclusions = dossier.whoShouldNotBuy ?? [];
  return {
    facts: facts.length,
    primaryFacts: byTier('primary'),
    expertFacts: byTier('expert'),
    ownerFacts: byTier('owner'),
    aggregatorFacts: byTier('aggregator'),
    untieredFacts: untiered,
    datedFacts: facts.filter((f) => dated(f.date)).length,
    products: (dossier.products ?? []).length,
    failureModes: (dossier.failureModes ?? []).length,
    whoShouldNotBuy: exclusions.length,
    groundedExclusions: exclusions.filter(grounded).length,
    ownerComplaints: ownerComplaints.length,
    attributedOwnerComplaints: ownerComplaints.filter(attributed).length,
    aggregateFaultRates: ownerComplaints.filter(aggregateFaultRate).length,
    priceObservations: priceObservations.length,
    datedPriceObservations: priceObservations.filter((o) => dated(o.dateChecked)).length,
    testedClaims: (dossier.testedClaims ?? []).length,
    competingCoverage:
      (dossier.competitorNotes ?? '').trim().length >= MEANINGFUL_NOTES_CHARS ? 1 : 0,
  };
}

/**
 * The evidence-sufficiency gate. Deterministic, run after synthesis, and the
 * last thing between a thin dossier and five stages of Opus 5 spent writing
 * spec recitation from it.
 *
 * The failure it exists for is quiet: a dossier of a dozen manufacturer specs
 * reads as a full research stage and passes every shape check, and the writer
 * then has nothing to say that the spec sheet does not already say. Counting
 * the strata separately is what makes that visible.
 */
export function checkEvidence(
  dossier: ResearchDossier,
  postType: string,
  category?: string,
): EvidenceSufficiency {
  const bar = barFor(postType, category);
  const counts = countEvidence(dossier);

  const shortfalls: EvidenceShortfall[] = (
    Object.entries(bar) as Array<[keyof EvidenceBar, number]>
  )
    .filter(([measure, need]) => need > 0 && (counts[measure] ?? 0) < need)
    // One published fault rate over a stated sample says more about ownership
    // than four hand-picked quotes ever could, so it settles the stratum.
    .filter(
      ([measure]) => !(measure === 'attributedOwnerComplaints' && counts.aggregateFaultRates > 0),
    )
    .map(([measure, need]) => {
      const { stratum, label } = STRATUM_OF[measure];
      return { stratum, label, have: counts[measure] ?? 0, need, fix: STRATUM_FIX[stratum] };
    });

  return {
    pass: shortfalls.length === 0,
    postType,
    counts,
    shortfalls,
    message: describe(postType, counts, shortfalls),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * What an operator reads on a failed card. It names the gap, says why the
 * piece stops here rather than proceeding, and lists where each thin stratum
 * is actually gathered - a message that only says "insufficient evidence"
 * leaves someone re-running the same stage and getting the same result.
 */
function describe(
  postType: string,
  counts: Record<string, number>,
  shortfalls: EvidenceShortfall[],
): string {
  if (shortfalls.length === 0) {
    return `Evidence sufficient for a ${postType}: ${counts.primaryFacts} primary, ${counts.expertFacts} expert and ${counts.ownerFacts} owner facts, ${counts.attributedOwnerComplaints} attributed owner complaint(s), ${counts.failureModes} failure mode(s), ${counts.datedPriceObservations} dated price observation(s).`;
  }
  const missing = shortfalls.map((s) => `${s.label} ${s.have}/${s.need}`).join(', ');
  const byStratum = [...new Set(shortfalls.map((s) => s.stratum))]
    .map((stratum) => `  - ${stratum}: ${STRATUM_FIX[stratum]}`)
    .join('\n');
  return [
    `Evidence is too thin to write a ${postType} from - ${missing}.`,
    `Written from this the piece could only recite specs, which is the reading that got the site flagged, so it stops here instead of spending the writing stages on it.`,
    `Re-run research after widening these strata (or add the missing evidence to the topic brief by hand):`,
    byStratum,
  ].join('\n');
}

/**
 * The bar, in a sentence, for the prompt that has to clear it.
 *
 * Generated from EVIDENCE_BAR rather than written out beside it: a threshold
 * the model is told about and a threshold the code enforces have to be the
 * same number, and the only way to guarantee that is to print the one the code
 * reads. A stage that fails a count nobody mentioned is a stage that fails
 * twice for the same reason.
 */
export function describeBar(postType: string, category?: string): string {
  const bar = barFor(postType, category);
  const needs = (Object.entries(bar) as Array<[keyof EvidenceBar, number]>)
    .filter(([, need]) => need > 0)
    .map(([measure, need]) => `${STRATUM_OF[measure].label} (${need})`);
  const a = /^[aeiou]/i.test(postType) ? 'An' : 'A';
  return (
    `A deterministic gate counts your reply before anything is written from it. ` +
    `${a} ${postType}${category ? ` in ${category}` : ''} needs at least: ${needs.join(', ')}. ` +
    `One published fault rate (kind "aggregate", with its sample size and field window) ` +
    `stands in for the individual owner complaints. Meet the bar with evidence you actually ` +
    `found - a padded count fails a reader where it would only have failed a counter.`
  );
}

/**
 * The gate's failure, thrown from the research stage so `runStage`'s existing
 * catch routes the article to `failed` with this message on the card. A
 * distinct class so a caller can tell "the evidence was thin" from "the model
 * fell over", without a second failure path through the runner.
 */
export class EvidenceGateError extends Error {
  constructor(readonly sufficiency: EvidenceSufficiency) {
    super(sufficiency.message);
    this.name = 'EvidenceGateError';
  }
}

/**
 * Run the gate and stop the article here when it comes up short. Stamps the
 * verdict onto the dossier either way, so a piece that passes carries the
 * evidence density it passed on into the panel.
 */
export function assertEvidenceSufficient(
  dossier: ResearchDossier,
  postType: string,
  category?: string,
): ResearchDossier {
  dossier.sufficiency = checkEvidence(dossier, postType, category);
  if (!dossier.sufficiency.pass) throw new EvidenceGateError(dossier.sufficiency);
  return dossier;
}
