// Researcher - builds an evidence dossier for an approved topic. Not a flat
// list of facts: five strata, gathered separately and filed separately, so the
// writer gets the material a spec sheet cannot supply.
//
// The strata exist because of what the old two-pass sweep produced. A dozen
// manufacturer specs and a product list reads as a complete research stage and
// passes every shape check, and the writer downstream then has nothing to say
// beyond what the box already says. What breaks after six months, what the
// one-star reviews agree on, who should walk away, what the price has done -
// none of it was ever gathered, so none of it could ever be written. That is
// an evidence deficiency, and it is fixed here or not at all.
//
// The Tavily sweep still runs first and unconditionally. It is the evidence
// floor — breadth the model does not have to think to ask for — and the search
// tool is what the model uses on top of it to check the specifics that matter.
import { chatJson, type ShapeCheck, UsageTracker } from '../llm/index.js';
import { formatSearches, type SearchHit, tavilySearchMany } from '../tools/tavily.js';
import { assertEvidenceSufficient, describeBar, normaliseDossier } from '../content/evidence.js';
import { operatorBrief, siteContext, SOURCE_DISCIPLINE, VERIFICATION_RULES } from './context.js';
import type { ArticleRow, ResearchDossier, TopicRow } from '../pipeline/types.js';

/**
 * The five strata, planned and searched separately.
 *
 * Separate queries are the whole point. One blended sweep returns whatever the
 * SERP ranks highest, which is other people's roundups; asking owner-complaint
 * questions in their own queries is the only way ProductReview.com.au threads
 * and one-star reviews ever surface.
 */
export const STRATA = [
  {
    key: 'primary',
    label: 'PRIMARY / MANUFACTURER',
    brief: "the maker's spec sheets, model numbers, RRPs and official availability",
  },
  {
    key: 'expert',
    label: 'INDEPENDENT EXPERT REVIEWS',
    brief:
      'reviewers who measured something themselves - Choice lab tests, RTINGS, teardowns, standards testing',
  },
  {
    key: 'owner',
    label: 'OWNER REVIEWS AND LONG-TERM COMPLAINTS',
    brief:
      'ProductReview.com.au, Choice member reliability surveys, Whirlpool Forums and OzBargain for tech, ' +
      'Bunnings verified-purchase reviews for home, Reddit, "after 6 months", "stopped working", warranty and return experiences',
  },
  {
    key: 'price',
    label: 'PRICE AND AVAILABILITY',
    brief:
      'named Australian retailer listings with a price and the day it was seen, price history, stock status',
  },
  {
    key: 'competing',
    label: 'COMPETING COVERAGE',
    brief: 'the pages currently ranking for this query - what they cover and where they are thin',
  },
] as const;

type StratumKey = (typeof STRATA)[number]['key'];

/** Queries per stratum. Ten searches total is the budget for one dossier. */
const QUERIES_PER_STRATUM = 2;

/** Used when the planner returns nothing for a stratum - never search blind. */
function fallbackQuery(key: StratumKey, title: string): string {
  switch (key) {
    case 'primary':
      return `${title} specifications official site`;
    case 'expert':
      return `${title} review tested`;
    case 'owner':
      return `${title} problems after 6 months owner reviews productreview.com.au`;
    case 'price':
      return `${title} price australia`;
    case 'competing':
      return `best ${title}`;
  }
}

/** One stratum with the queries that will actually be run for it. */
export interface PlannedStratum {
  key: StratumKey;
  label: string;
  brief: string;
  queries: string[];
}

/**
 * The planner's reply, made usable: every stratum ends up with at least one
 * query, whatever the model returned. A stratum the model skipped falls back
 * to a hand-written query rather than to nothing, because a missing owner
 * sweep is exactly the hole this stage exists to close.
 */
export function planStrata(plan: unknown, title: string): PlannedStratum[] {
  // Models occasionally wrap the object in the key the old prompt used. Reach
  // through that rather than silently falling back to the default queries.
  const reply = plan !== null && typeof plan === 'object' ? (plan as Record<string, unknown>) : {};
  const nested = reply.queries;
  const strata = (
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : reply
  ) as Record<string, unknown>;

  return STRATA.map((stratum) => {
    const queries = (Array.isArray(strata[stratum.key]) ? (strata[stratum.key] as unknown[]) : [])
      .filter((query): query is string => typeof query === 'string' && query.trim() !== '')
      .map((query) => query.trim())
      .slice(0, QUERIES_PER_STRATUM);
    return {
      ...stratum,
      queries: queries.length > 0 ? queries : [fallbackQuery(stratum.key, title)],
    };
  });
}

/**
 * The evidence blob the synthesis pass reads, grouped under its stratum
 * headings. The grouping is load-bearing: "fill each field from its own group"
 * only means something if the groups are visible in the prompt.
 */
export function groupEvidence(
  planned: PlannedStratum[],
  searches: Array<{ query: string; results: SearchHit[] }>,
): string {
  const byQuery = new Map(searches.map((s) => [s.query, s]));
  return planned
    .map(
      (stratum) =>
        `## ${stratum.label} EVIDENCE - ${stratum.brief}\n\n` +
        formatSearches(stratum.queries.map((query) => byQuery.get(query) ?? { query, results: [] })),
    )
    .join('\n\n');
}

export async function runResearcher(
  article: ArticleRow,
  topic: TopicRow | null,
  model: string,
  tracker: UsageTracker,
): Promise<ResearchDossier> {
  const keywords = topic?.keywords?.length ? topic.keywords.join(', ') : article.title;
  const brief = operatorBrief(topic);

  // Pass 1: plan the searches, one set per stratum. Asking for a single list
  // is what produced a single kind of evidence.
  const plan = await chatJson<Record<string, string[]>>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}`,
      temperature: 0.4,
      prompt: `Plan web research for this piece:
Title: ${article.title}
Category: ${article.category} | Post type: ${article.post_type}
Angle: ${topic?.angle ?? 'n/a'}
Target keywords: ${keywords}
${brief ? `\n${brief}\n\nLet the operator brief steer these queries: search to verify and expand on it, not to second-guess it.\n` : ''}
Return JSON with exactly these keys, each holding ${QUERIES_PER_STRATUM} search queries:
${STRATA.map((s) => `"${s.key}": ${s.label.toLowerCase()} - ${s.brief}`).join('\n')}

Write each query the way someone hunting that specific evidence would type it.
The owner queries matter most and are the easiest to get wrong: "best X" returns
roundups, "X won't hold charge reddit" returns owners. Name real sites and real
symptoms there, not adjectives.

Example shape: {${STRATA.map((s) => `"${s.key}": ["...", "..."]`).join(', ')}}`,
    },
    tracker,
  );

  const planned = planStrata(plan, article.title);

  // De-duped: two strata can land on the same phrasing, and a repeated query
  // is a paid search that returns what we already have.
  const searches = await tavilySearchMany([...new Set(planned.flatMap((s) => s.queries))], 5);
  const evidence = groupEvidence(planned, searches);

  // Pass 2: synthesize the dossier, each stratum filled from its own evidence.
  const dossier = await chatJson<ResearchDossier>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${VERIFICATION_RULES}`,
      temperature: 0.3,
      maxTokens: 12000,
      search: true,
      prompt: `Synthesize a research dossier for "${article.title}" (${article.post_type}, ${article.category}).
${brief ? `\n${brief}\n\nFold the operator's reference materials into the dossier as facts (with their source where given), and let the operator instructions shape the summary and angle. They are authoritative source material, on par with the search evidence below.\n` : ''}
STRICT RULES:
- Your facts come from three places and nowhere else: the evidence below${brief ? ', the operator brief above' : ''},
  and what you confirm yourself with web_search / read_page. Never invent a
  spec, a price or a URL, and never carry one over from memory.
- VERIFY BEFORE YOU FILE. Every price, model number, headline spec and
  availability claim gets checked against a primary source — the maker's page
  or the retailer's listing — before it enters the dossier. Prices are AUD and
  move weekly; an unchecked one is the single most likely thing to be wrong.
  Anything that survives the check is a fact; anything that doesn't is dropped,
  not hedged into the dossier for a later stage to trip over.
- STAY IN YOUR STRATUM. The evidence below is grouped by where it came from,
  and each dossier field is filled from its own group and no other:
  ownerComplaints and failureModes come from the OWNER block (and from owner
  threads you open yourself); testedClaims from the EXPERT block;
  priceObservations from the PRICE block; competitorNotes from the COMPETING
  block. A spec sheet cannot tell you what breaks, and an owner thread cannot
  tell you the RRP.
- TIER EVERY FACT. tier is one of: "primary" (the maker, the standards body,
  the retailer's own listing), "expert" (an independent reviewer who measured
  something), "owner" (someone who bought and used it), "aggregator" (a site
  restating other people's numbers - weakest, and never the only source for a
  claim that matters). If you cannot place a source, write "unknown" rather
  than guessing upward.
- DATE EVERY FACT THE SOURCE DATES. date is "YYYY-MM-DD", "YYYY-MM" or "YYYY"
  as the source gives it, and null when the source carries no date. Never
  invent one, and never fill it with today's date to look current.
- NAME WHO SAID IT. publisher is the source in a reader's words - "Choice",
  "Rtings", "Sony", "ProductReview.com.au" - and null when the page names no
  publisher. It is what lets the article attribute the claim instead of
  asserting it.
- KNOW YOUR AUSTRALIAN SOURCES. Choice's member reliability surveys ARE owner
  evidence (owner-assessed, brand-level, sample size published) - tier them
  "owner" and carry the sample size. Choice's lab results are "expert".
  Canstar Blue is a commissioned paid panel that licenses award logos to the
  brands it rates: tier it "aggregator", never "expert" or "owner", and never
  file it as a testedClaim. Retailer reviews (JB Hi-Fi, The Good Guys,
  Bunnings) count only where the review is a verified purchase and is neither
  syndicated from another market nor written for an incentive; store-service
  ratings ("delivery was fast") are not product evidence at all. For Health
  topics there is no strong Australian owner corpus - say the sample is small
  rather than inflating it.
- amazonUrl: an Amazon PRODUCT page URL (amazon.com.au or amazon.com, containing
  /dp/ or /gp/product/) that you have actually seen in the evidence or in a
  search result — else null. A retailer or news site URL is NEVER an amazonUrl,
  and neither is a URL you assembled from an ASIN you remember. Products without
  one are still fine: the pipeline links them via an Amazon search fallback.
- goSlug is the kebab-case affiliate slug for the product (e.g. "sony-wh-1000xm6").
- 3-6 products for guides/roundups; for articles include products only if relevant.
- competitorNotes describes what the top pages cover and where they are thin.
  It is the one field allowed to discuss them, and even there: no facts lifted,
  no URLs that will end up in the body.
- OWNER COMPLAINTS CARRY A DENOMINATOR. A complaint counts when it says how
  much of the corpus it speaks for - "37 of 412 ProductReview reviews mention
  it", "9% of 1,076 owners surveyed" - and links the page it came from. Set
  kind: "aggregate" for a published fault rate over a stated sample (with the
  field window in recency) and kind: "quoted" for individual owner reports.
  One aggregate rate is worth more than four picked-out quotes, and the gate
  accepts it in their place.
- whoShouldNotBuy ROUTES A BUYER, it does not condemn the product. Each entry
  names a concrete situation ("makes milk drinks for two or more people"), a
  reason tied to something someone measured, and where possible the
  alternative - and carries the sourceUrl that reason came from. One real
  exclusion is the bar. Never pad to a second: "not for everyone", "not for
  beginners" and "too expensive" route nobody and are dropped in code.
- PRICES ARE DATED THE DAY THEY WERE SEEN. dateChecked is when you saw that
  price on that retailer's listing, never the publication date of the piece
  and never today's date on a price you did not open.
- Thin is better than invented. A stratum with three real findings beats one
  with eight you padded, and the pipeline checks these counts in code after
  you reply - a fabricated complaint fails a human reader instead of a counter.

${describeBar(article.post_type, article.category)}

Evidence, grouped by stratum (the floor, not the ceiling - check what matters
before you file it):
${evidence}

Return JSON:
{"summary": string (what the piece should say, 3-5 sentences),
 "facts": [{"fact": string, "sourceUrl": string,
            "tier": "primary"|"expert"|"owner"|"aggregator"|"unknown",
            "date": string|null, "publisher": string|null}] (10-18 concrete
           facts, spread across tiers),
 "products": [{"name": string, "brand": string, "approxPrice": string,
               "amazonUrl": string|null, "goSlug": string, "notes": string}],
 "failureModes": [{"product": string, "failure": string (what actually breaks),
                   "timeframe": string (e.g. "after 6-12 months"),
                   "sourceUrl": string, "tier": "owner"|"expert"|"primary"|"aggregator"|"unknown"}],
 "whoShouldNotBuy": [{"audience": string (a concrete buyer situation),
                      "reason": string (tied to a measured attribute, and the
                                alternative where there is one),
                      "sourceUrl": string}],
 "ownerComplaints": [{"product": string, "complaint": string,
                      "volume": "isolated"|"recurring"|"widespread"|"unknown"
                                (how much of the owner corpus says it),
                      "recency": string|null (YYYY / YYYY-MM / YYYY-MM-DD of the
                                 reviews saying it, null if undated),
                      "denominator": string|null ("37 of 412 reviews",
                                     "9% of 1,076 owners surveyed"),
                      "kind": "quoted"|"aggregate",
                      "sourceUrl": string}],
 "priceObservations": [{"product": string, "value": number, "currency": string (ISO, usually "AUD"),
                        "retailer": string (named), "dateChecked": string
                        (YYYY-MM-DD you saw this price),
                        "sourceUrl": string}],
 "testedClaims": [{"claim": string (what was measured, with the figure),
                   "source": string (who tested it, named), "year": number|null,
                   "sourceUrl": string}],
 "keywords": {"primary": string, "secondary": string[]},
 "competitorNotes": string (what competing pages cover + the gap we can win),
 "faqIdeas": [{"question": string, "answerHint": string}] (3-6)}`,
    },
    tracker,
    dossierCheck(article.post_type),
  );

  // Normalize defensively - downstream link integrity, tiering and the
  // evidence gate all depend on this shape being real rather than claimed.
  //
  // Then the gate, in code, on the normalised dossier: a piece that cannot
  // clear its stratum minimums stops here rather than spending the outline,
  // write, review and edit stages producing spec recitation. The throw is the
  // route to `failed` — runStage's catch writes the status, the message and
  // releases the claim already, so there is no second failure path to keep.
  return assertEvidenceSufficient(normaliseDossier(dossier), article.post_type, article.category);
}

/**
 * The dossier contract, enforced rather than hoped for.
 *
 * A truncated reply once reached the database as its own `facts` array: valid
 * JSON, 14 real facts, and no `products` at all. Every stage downstream read
 * it through `?? []`, reported success, and would have published a guide whose
 * affiliate table was empty — the one defect that costs money rather than
 * quality. `products` is required for a guide or roundup for exactly that
 * reason; a plain article may legitimately have none.
 *
 * The evidence strata are required as arrays, empty or not. A model that
 * simply omits `ownerComplaints` and one that looked and found none are
 * indistinguishable downstream, and only the second is honest - so an omitted
 * field is a reprompt here, and an empty one is the evidence gate's problem.
 */
export function dossierCheck(postType: string): ShapeCheck<ResearchDossier> {
  const needsProducts = postType === 'guide' || postType === 'roundup';
  const STRATUM_ARRAYS = [
    'failureModes',
    'whoShouldNotBuy',
    'ownerComplaints',
    'priceObservations',
    'testedClaims',
  ] as const;
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `Expected the whole dossier as a JSON object, got ${
        Array.isArray(value) ? 'an array — you returned one field instead of the object' : typeof value
      }.`;
    }
    const d = value as Partial<ResearchDossier>;
    const problems: string[] = [];
    if (!Array.isArray(d.facts) || d.facts.length === 0) problems.push('"facts" must be a non-empty array');
    if (!d.keywords?.primary?.trim()) problems.push('"keywords.primary" is required');
    if (!d.summary?.trim()) problems.push('"summary" is required');
    if (needsProducts && (!Array.isArray(d.products) || d.products.length === 0)) {
      problems.push(`"products" must list 3-6 contenders for a ${postType} — the piece cannot be linked without them`);
    }
    const missingStrata = STRATUM_ARRAYS.filter((field) => !Array.isArray(d[field]));
    if (missingStrata.length > 0) {
      problems.push(
        `${missingStrata.map((f) => `"${f}"`).join(', ')} must each be an array - use [] only when ` +
          `the evidence genuinely has none, never to skip a stratum you did not look at`,
      );
    }
    return problems.length > 0 ? `The dossier is incomplete: ${problems.join('; ')}.` : null;
  };
}
