// The deterministic half of the research stage: how a raw dossier is cleaned
// up, and how much evidence a piece must carry before anyone is allowed to
// write from it.
//
// It lives apart from researcher.ts because none of it involves a model. The
// researcher gathers and synthesises; this file decides what the synthesis is
// actually worth, in code, the same way every time. Nothing here calls an LLM
// or the network, which is also what makes it testable.
import { parseAmazonUrl, slugify } from '../content/contract.js';
import type {
  BuyerExclusion,
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

/** How each stratum is gathered - printed in the gate's message when it is thin. */
const STRATUM_FIX: Record<string, string> = {
  primary:
    "the maker's own spec page or the retailer's product listing - search the model number plus \"specifications\"",
  expert: 'independent expert reviews that measured something (Choice, Canstar Blue, a lab test)',
  owner:
    'ProductReview.com.au, Reddit threads, and the 1-2 star reviews on the retailer listings - that is where six-month faults surface',
  price: 'a named retailer listing, with the day you checked it',
  competing: 'read the pages currently ranking and say what they cover and where they are thin',
};

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
  ownerComplaints: number;
  whoShouldNotBuy: number;
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
    ownerComplaints: 4,
    whoShouldNotBuy: 2,
    datedPriceObservations: 3,
    competingCoverage: 1,
  },
  roundup: {
    primaryFacts: 3,
    expertFacts: 2,
    ownerFacts: 3,
    testedClaims: 1,
    failureModes: 2,
    ownerComplaints: 3,
    whoShouldNotBuy: 2,
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
    ownerComplaints: 0,
    whoShouldNotBuy: 0,
    datedPriceObservations: 0,
    competingCoverage: 1,
  },
};

/** An unrecognised post type is held to the article bar, never to nothing. */
export function barFor(postType: string): EvidenceBar {
  return EVIDENCE_BAR[postType] ?? EVIDENCE_BAR.article;
}

/** Which count each bar entry reads, and how it is named to an operator. */
const STRATUM_OF: Record<keyof EvidenceBar, { stratum: string; label: string }> = {
  primaryFacts: { stratum: 'primary', label: 'facts from a primary source' },
  expertFacts: { stratum: 'expert', label: 'facts from independent expert reviews' },
  ownerFacts: { stratum: 'owner', label: 'facts from owner reviews' },
  testedClaims: { stratum: 'expert', label: 'tested claims (measured, attributed, dated)' },
  failureModes: { stratum: 'owner', label: 'failure modes' },
  ownerComplaints: { stratum: 'owner', label: 'owner complaints' },
  whoShouldNotBuy: { stratum: 'owner', label: 'buyers who should skip this' },
  datedPriceObservations: { stratum: 'price', label: 'dated price observations' },
  competingCoverage: { stratum: 'competing', label: 'a read of the competing coverage' },
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
 * A date the way a source gives one: a year, a month, or a day. Anything else
 * - "recently", "last year", an empty string - is undated, and says so.
 */
export function normaliseDate(value: unknown): string | null {
  const raw = text(value).split('T')[0];
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(year) < 1900) return null;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) return null;
  if (day !== undefined && (Number(day) < 1 || Number(day) > 31)) return null;
  return raw;
}

/** A price as a number, from "A$1,299.00" or 1299 alike. Null when unusable. */
function normalisePrice(value: unknown): number | null {
  const numeric =
    typeof value === 'number' ? value : Number(text(value).replace(/[^\d.]/g, ''));
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

/**
 * Whether a source actually gave a date. A missing field counts as undated the
 * same way an explicit null does - the two are the same evidence.
 */
const dated = (value: string | null | undefined): boolean => typeof value === 'string' && value !== '';

/** Every measurable quantity in a dossier, counted once. */
export function countEvidence(dossier: ResearchDossier): Record<string, number> {
  const facts = dossier.facts ?? [];
  const byTier = (tier: SourceTier): number => facts.filter((f) => f.tier === tier).length;
  // Anything the normaliser did not place, plus facts from dossiers written
  // before tiering existed - both are untiered, and neither is a stratum.
  const untiered = facts.filter((f) => !KNOWN_TIERS.includes(f.tier)).length;
  const priceObservations = dossier.priceObservations ?? [];
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
    whoShouldNotBuy: (dossier.whoShouldNotBuy ?? []).length,
    ownerComplaints: (dossier.ownerComplaints ?? []).length,
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
export function checkEvidence(dossier: ResearchDossier, postType: string): EvidenceSufficiency {
  const bar = barFor(postType);
  const counts = countEvidence(dossier);

  const shortfalls: EvidenceShortfall[] = (
    Object.entries(bar) as Array<[keyof EvidenceBar, number]>
  )
    .filter(([measure, need]) => need > 0 && (counts[measure] ?? 0) < need)
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
    return `Evidence sufficient for a ${postType}: ${counts.primaryFacts} primary, ${counts.expertFacts} expert and ${counts.ownerFacts} owner facts, ${counts.ownerComplaints} owner complaint(s), ${counts.failureModes} failure mode(s), ${counts.datedPriceObservations} dated price observation(s).`;
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
