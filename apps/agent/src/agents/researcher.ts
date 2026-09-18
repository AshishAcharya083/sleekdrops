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
import { chatJson, requireKeys, type ShapeCheck, UsageTracker } from '../llm/index.js';
import { formatSearches, type SearchHit, tavilySearchMany } from '../tools/tavily.js';
import {
  assertEvidenceSufficient,
  checkEvidence,
  describeBar,
  LAUNCH_WINDOW_DAYS,
  normaliseDossier,
  STRATUM_FIX,
} from '../content/evidence.js';
import { operatorBrief, siteContext, SOURCE_DISCIPLINE, VERIFICATION_RULES } from './context.js';
import type {
  ArticleRow,
  EvidenceShortfall,
  ResearchDossier,
  TopicRow,
} from '../pipeline/types.js';

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
    // Generated from the gate's own accept-list: the outlets the prompt is
    // told to search and the outlets the gate's advice names have to be one
    // list, or the stage fails a bar nobody mentioned.
    brief: STRATUM_FIX.expert,
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
      return `${title} review tested measured gsmarena notebookcheck`;
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

/**
 * The queries a second sweep runs for one thin stratum.
 *
 * Derived from the stratum rather than from the plan the first pass wrote,
 * which is the point: the first plan is the thing that came up short, so
 * re-running its phrasing buys another set of the same results. These name
 * the sources the stratum is actually gathered from - the protocol-publishing
 * outlets for expert, the owner corpora for owner - because a stratum comes up
 * thin far more often from asking the wrong question than from the evidence
 * not existing.
 */
export function resweepQueries(stratum: string, title: string): string[] {
  switch (stratum) {
    case 'primary':
      return [`${title} official specifications press release`, `${title} RRP australia official announcement`];
    case 'expert':
      return [
        `${title} gsmarena review battery test screen brightness`,
        `${title} notebookcheck OR dxomark OR displaymate OR ifixit measured`,
      ];
    case 'owner':
      return [`${title} problems reddit owners`, `${title} productreview.com.au reviews complaints`];
    case 'price':
      return [`${title} price australia jb hi-fi officeworks`, `${title} australia launch price rrp`];
    case 'competing':
      return [`best ${title} australia`, `${title} review comparison which to buy`];
    default:
      return [`${title} ${stratum}`];
  }
}

/**
 * The second sweep's plan: one entry per thin stratum, and nothing else.
 *
 * Scoped deliberately. A shortfall in the expert stratum is not a reason to
 * pay for another price sweep, and a re-sweep that re-gathers everything is a
 * second full research pass wearing a remediation's clothes.
 */
export function resweepPlan(
  shortfalls: readonly EvidenceShortfall[],
  title: string,
): PlannedStratum[] {
  const thin = new Set(shortfalls.map((s) => s.stratum));
  return STRATA.filter((stratum) => thin.has(stratum.key)).map((stratum) => ({
    ...stratum,
    queries: resweepQueries(stratum.key, title),
  }));
}

/** Which dossier arrays a stratum owns - what a re-sweep of it may add to. */
const STRATUM_FIELDS: Record<string, ReadonlyArray<keyof ResearchDossier>> = {
  primary: ['facts'],
  expert: ['facts', 'testedClaims', 'claims'],
  owner: ['facts', 'failureModes', 'ownerComplaints', 'whoShouldNotBuy'],
  price: ['priceObservations'],
  competing: [],
};

/** The identity of an entry, for deciding whether a second sweep re-filed it. */
function entryKey(entry: unknown): string {
  const e = entry as Record<string, unknown>;
  const parts = [e.fact, e.claim, e.failure, e.complaint, e.audience, e.metric, e.retailer, e.product, e.sourceUrl]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .map((part) => (part as string).trim().toLowerCase());
  return parts.join('|');
}

/**
 * The first dossier with a second sweep's findings folded in.
 *
 * Additive and deduplicated: the first pass's evidence is not replaced, and an
 * entry the second pass re-filed from the same page does not get counted
 * twice. Only the strata that came up thin are touched, so a re-sweep cannot
 * quietly rewrite the summary, the product list or the keywords the rest of
 * the pipeline is already built on.
 */
export function mergeDossier(
  base: ResearchDossier,
  addition: Partial<ResearchDossier>,
  shortfalls: readonly EvidenceShortfall[],
): ResearchDossier {
  const strata = new Set(shortfalls.map((s) => s.stratum));
  const merged: ResearchDossier = { ...base };
  const fields = new Set([...strata].flatMap((stratum) => STRATUM_FIELDS[stratum] ?? []));

  for (const field of fields) {
    const existing = (base[field] ?? []) as unknown[];
    const found = (addition[field] ?? []) as unknown[];
    if (!Array.isArray(found) || found.length === 0) continue;
    const seen = new Set(existing.map(entryKey));
    const extra = found.filter((entry) => {
      const key = entryKey(entry);
      if (key === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    (merged as unknown as Record<string, unknown>)[field] = [...existing, ...extra];
  }

  // The competing-coverage read is a single piece of prose, not a list: a
  // second sweep either produced a fuller one or it did not.
  if (strata.has('competing')) {
    const found = (addition.competitorNotes ?? '').trim();
    if (found.length > (base.competitorNotes ?? '').trim().length) merged.competitorNotes = found;
  }
  // A release date the first pass missed is what decides whether the launch
  // window applies at all, so it is carried through even though no stratum
  // owns it.
  if (base.launch == null && addition.launch != null) merged.launch = addition.launch;

  return merged;
}

/**
 * The gate, with one bounded remediation in front of it.
 *
 * Research used to be one shot: plan, synthesise, count, die. One thin
 * stratum - the iPhone 18 piece failed on expert facts 1 of 2, for a product
 * with hundreds of published articles behind it - was a terminal card. That is
 * the same wrong shape the missing-product-list path had: a narrow, recoverable
 * fault treated as a verdict.
 *
 * So a shortfall buys one more sweep, scoped to the strata that were actually
 * thin, and the gate runs again on the merged dossier. One attempt, by
 * construction rather than by a counter: the second verdict is asserted, so a
 * piece that is still short after a targeted re-sweep genuinely has nothing to
 * be written from and stops here.
 */
export async function sweepUntilSufficient(
  dossier: ResearchDossier,
  article: ArticleRow,
  resweep: (shortfalls: EvidenceShortfall[]) => Promise<Partial<ResearchDossier>>,
): Promise<ResearchDossier> {
  const first = checkEvidence(dossier, article.post_type, article.category);
  if (first.pass) {
    dossier.sufficiency = first;
    return dossier;
  }
  // Best-effort: a re-sweep that falls over (a timeout, a model error) must not
  // replace "the evidence was too thin, here is which stratum" with "fetch
  // failed". The remediation is what is optional here, not the verdict.
  let addition: Partial<ResearchDossier> = {};
  try {
    addition = await resweep(first.shortfalls);
  } catch (err) {
    console.warn(
      `[research] targeted re-sweep failed, falling back to the first verdict: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const widened = mergeDossier(dossier, normaliseDossier(addition), first.shortfalls);
  return assertEvidenceSufficient(widened, article.post_type, article.category);
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
- WIDEN THE EXPERT STRATUM TO ANYONE WHO PUBLISHES A PROTOCOL. ${STRATUM_FIX.expert}.
- NEW RELEASES: fill "launch" when the piece is about a product that went on
  sale in roughly the last ${LAUNCH_WINDOW_DAYS} days, with the release date and
  where you got it. Inside that window no Australian lab result exists yet, and
  the gate stops asking for one - but it still asks for expert coverage, which
  inside the window means the protocol-publishing outlets above and dated
  hands-on where something was measured.
- LABEL EVERY HEADLINE NUMBER IN "claims". One row per figure that matters,
  carrying both halves where they disagree: the maker's claimedValue with
  claimedBy and claimedSourceUrl, and the measuredValue with measuredBy, the
  conditions it was measured under and the date. Never drop the maker's figure
  - the reader has already seen it on the box, and the gap between the two is
  the most useful thing on the page - and never restate it as if it were a
  measurement. A metric nobody has measured yet is still a row: claimedValue
  filled, measuredValue null. Set ownTest only if WE ran the test, which today
  we do not. Fill "covers" with what the source's result actually covers
  whenever the source rates a brand or a tested cohort rather than this exact
  model (Canstar Blue, CHOICE) - a rating attached to a model it does not cover
  is refused in code.
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
 "claims": [{"subject": string (the product this figure is about),
             "metric": string ("Battery life, screen-on", "Peak brightness"),
             "claimedValue": string|null, "claimedBy": string|null (the brand),
             "claimedSourceUrl": string|null,
             "claimedConditions": string|null (the conditions the maker states),
             "measuredValue": string|null, "measuredBy": string|null (the outlet),
             "conditions": string|null (the protocol it was measured under),
             "measuredOn": string|null (YYYY / YYYY-MM / YYYY-MM-DD),
             "measuredSourceUrl": string|null,
             "withdrawnValue": string|null (a figure the tester has since corrected away from),
             "ownTest": false,
             "covers": string|null (what the source's result actually covers)}],
 "launch": {"product": string, "releaseDate": string (YYYY-MM-DD it went on sale),
            "sourceUrl": string}|null,
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
  // Then the gate, in code, on the normalised dossier - with one targeted
  // re-sweep in front of it, so a single thin stratum buys a second look
  // rather than a dead card. A piece still short after that stops here rather
  // than spending the outline, write, review and edit stages producing spec
  // recitation. The throw is the route to `failed` - runStage's catch writes
  // the status, the message and releases the claim already, so there is no
  // second failure path to keep.
  const normalised = normaliseDossier(dossier);
  return sweepUntilSufficient(normalised, article, (shortfalls) =>
    runTargetedResweep(article, topic, normalised, shortfalls, model, tracker),
  );
}

/**
 * One more sweep, over the thin strata only.
 *
 * It is given what the first pass already filed, so the model is adding to a
 * dossier rather than writing a second one: duplicates are dropped in
 * `mergeDossier` anyway, but a model that can see the existing rows spends its
 * pass on the gap instead of re-finding the same three pages. It returns only
 * the strata that were short - everything else on the dossier is already
 * settled and a re-sweep has no business rewriting it.
 */
export async function runTargetedResweep(
  article: ArticleRow,
  topic: TopicRow | null,
  dossier: ResearchDossier,
  shortfalls: readonly EvidenceShortfall[],
  model: string,
  tracker: UsageTracker,
): Promise<Partial<ResearchDossier>> {
  const planned = resweepPlan(shortfalls, article.title);
  if (planned.length === 0) return {};

  const searches = await tavilySearchMany([...new Set(planned.flatMap((s) => s.queries))], 5);
  const evidence = groupEvidence(planned, searches);
  const brief = operatorBrief(topic);
  const gaps = shortfalls
    .map((s) => `- ${s.label}: ${s.have} of ${s.need} (${s.stratum}) - ${s.fix}`)
    .join('\n');
  const already = planned
    .map((stratum) => {
      const rows = existingRows(dossier, stratum.key);
      return `${stratum.label}: ${rows.length === 0 ? 'nothing filed' : rows.join(' | ')}`;
    })
    .join('\n');

  return chatJson<Partial<ResearchDossier>>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${VERIFICATION_RULES}`,
      temperature: 0.3,
      maxTokens: 6000,
      search: true,
      prompt: `The research dossier for "${article.title}" (${article.post_type}, ${article.category}) came up short in ${planned.length === 1 ? 'one stratum' : `${planned.length} strata`}. This is a second, targeted sweep over ${planned.length === 1 ? 'that stratum' : 'those strata'} and nothing else.
${brief ? `\n${brief}\n` : ''}
WHAT IS MISSING:
${gaps}

WHAT THE FIRST PASS ALREADY FILED (do not repeat these - find what is not here):
${already}

RULES:
- Return ONLY the fields listed below. Everything else in the dossier is
  settled, and a second sweep that rewrites the summary, the product list or
  the keywords would undo a pass that already succeeded.
- Same discipline as the first pass: tier and date every fact, name the
  publisher, verify before you file, and never carry a spec or a URL over from
  memory.
- ${STRATUM_FIX.expert}.
- Return an empty array for anything you looked for and did not find. Padding
  a count here is worse than failing the piece: the gate is the last thing
  between a thin dossier and a page of spec recitation.

Search evidence for the thin ${planned.length === 1 ? 'stratum' : 'strata'}:
${evidence}

Return JSON with only these keys:
{${resweepShape(planned.map((p) => p.key))}}`,
    },
    tracker,
  );
}

/** What the first pass filed in a stratum, short enough to put in a prompt. */
function existingRows(dossier: ResearchDossier, stratum: string): string[] {
  switch (stratum) {
    case 'primary':
      return (dossier.facts ?? []).filter((f) => f.tier === 'primary').map((f) => f.fact);
    case 'expert':
      return [
        ...(dossier.facts ?? []).filter((f) => f.tier === 'expert').map((f) => f.fact),
        ...(dossier.testedClaims ?? []).map((t) => `${t.claim} (${t.source})`),
      ];
    case 'owner':
      return [
        ...(dossier.facts ?? []).filter((f) => f.tier === 'owner').map((f) => f.fact),
        ...(dossier.ownerComplaints ?? []).map((c) => c.complaint),
        ...(dossier.failureModes ?? []).map((f) => f.failure),
      ];
    case 'price':
      return (dossier.priceObservations ?? []).map((o) => `${o.retailer} ${o.value}`);
    case 'competing':
      return dossier.competitorNotes ? [dossier.competitorNotes.slice(0, 200)] : [];
    default:
      return [];
  }
}

/** The JSON keys a re-sweep of these strata may return, and nothing else. */
function resweepShape(strata: readonly string[]): string {
  const shapes: Record<string, string> = {
    facts: `"facts": [{"fact": string, "sourceUrl": string, "tier": "primary"|"expert"|"owner"|"aggregator"|"unknown", "date": string|null, "publisher": string|null}]`,
    testedClaims: `"testedClaims": [{"claim": string, "source": string, "year": number|null, "sourceUrl": string}]`,
    claims: `"claims": [{"subject": string, "metric": string, "claimedValue": string|null, "claimedBy": string|null, "claimedSourceUrl": string|null, "claimedConditions": string|null, "measuredValue": string|null, "measuredBy": string|null, "conditions": string|null, "measuredOn": string|null, "measuredSourceUrl": string|null, "withdrawnValue": string|null, "ownTest": false, "covers": string|null}]`,
    failureModes: `"failureModes": [{"product": string, "failure": string, "timeframe": string, "sourceUrl": string, "tier": "owner"|"expert"|"primary"|"aggregator"|"unknown"}]`,
    ownerComplaints: `"ownerComplaints": [{"product": string, "complaint": string, "volume": "isolated"|"recurring"|"widespread"|"unknown", "recency": string|null, "denominator": string|null, "kind": "quoted"|"aggregate", "sourceUrl": string}]`,
    whoShouldNotBuy: `"whoShouldNotBuy": [{"audience": string, "reason": string, "sourceUrl": string}]`,
    priceObservations: `"priceObservations": [{"product": string, "value": number, "currency": string, "retailer": string, "dateChecked": string, "sourceUrl": string}]`,
  };
  const fields = [...new Set(strata.flatMap((stratum) => STRATUM_FIELDS[stratum] ?? []))];
  const lines = fields.map((field) => shapes[field]).filter(Boolean);
  if (strata.includes('competing')) {
    lines.push(`"competitorNotes": string (what the top pages cover and where they are thin)`);
  }
  return lines.join(',\n ');
}

/**
 * Product discovery, as a remediation pass rather than a whole second dossier.
 *
 * The keyword stage is the first point at which "this piece has nothing to
 * link" is knowable: the dossier is built and the SERP read has just named the
 * intent. A dossier with no products at that point used to be terminal, which
 * is the wrong shape for a recoverable fault - a "best foldable" piece whose
 * research pass filed its evidence but never filed a product list is missing
 * one narrow thing, and one narrow search is what it takes to get it.
 *
 * So this asks for products and nothing else, against the keyword the piece is
 * actually being built to win. It returns what it found, including nothing:
 * inventing contenders to clear a gate is the failure this exists to avoid,
 * and an empty result is the caller's signal to fail the card.
 */
export async function runProductDiscovery(
  article: ArticleRow,
  topic: TopicRow | null,
  keyword: string,
  model: string,
  tracker: UsageTracker,
): Promise<ResearchDossier['products']> {
  const brief = operatorBrief(topic);
  const queries = [...new Set([`best ${keyword} australia`, `${keyword} price australia`])];
  const searches = await tavilySearchMany(queries, 5);

  const { products } = await chatJson<{ products: ResearchDossier['products'] }>(
    {
      model,
      system: `${siteContext()}\n\n${SOURCE_DISCIPLINE}\n\n${VERIFICATION_RULES}`,
      temperature: 0.2,
      search: true,
      prompt: `Name the products a buyer searching "${keyword}" is actually choosing between.

Working title: ${article.title}
Post type: ${article.post_type} | Category: ${article.category}
${brief ? `\n${brief}\n` : ''}
The research dossier for this piece was filed without a product list, and the
piece cannot recommend anything it cannot name. This pass fills that hole and
nothing else - no facts, no prices beyond an approximate RRP, no review copy.

RULES:
- Real models, on sale in Australia now, named the way the retailer names them
  ("Samsung Galaxy Z Fold 8", not "Samsung's latest foldable"). Check the
  evidence below or search before you file one.
- amazonUrl: an Amazon PRODUCT page URL (amazon.com.au or amazon.com, containing
  /dp/ or /gp/product/) you have actually seen - else null. Never assemble one
  from an ASIN you remember. Products without one are fine: the pipeline links
  them via an Amazon search fallback.
- goSlug is the kebab-case affiliate slug for the product ("samsung-galaxy-z-fold-8").
- approxPrice is AUD and approximate ("about A$2,899"), or "" when you could not
  check one. An invented price is worse than no price.
- 3-6 contenders. Return an empty array rather than padding with products that
  do not exist or are not sold here - the pipeline fails the piece honestly on
  an empty list, and a fabricated contender fails a reader instead.

Search evidence:
${formatSearches(searches)}

Return JSON:
{"products": [{"name": string, "brand": string, "approxPrice": string,
               "amazonUrl": string|null, "goSlug": string, "notes": string}]}`,
    },
    tracker,
    requireKeys<{ products: ResearchDossier['products'] }>('products'),
  );

  // Through the same normalisation the dossier gets: slugified goSlugs and
  // non-Amazon URLs dropped are what the assembler's link contract assumes.
  return normaliseDossier({ products }).products;
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
