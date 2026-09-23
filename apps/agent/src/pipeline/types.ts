// Row shapes and inter-agent data contracts (the session.state equivalents).
//
// `StructureShape` is the structure library's record (content/shapes.ts),
// imported under an alias because `ArticleShape` here is the id vocabulary the
// angle stage picks from and the library's record is the body behind one of
// those ids.
import type { ArticleShape as StructureShape } from '../content/shapes.js';
import type { HeroImageSource } from '../distribution/types.js';

export type { StructureShape };

export type Stage =
  | 'research'
  | 'keyword'
  | 'angle'
  | 'outline'
  | 'write'
  | 'seo_review'
  | 'edit'
  | 'assemble'
  | 'image'
  | 'publish'
  | 'done';

/**
 * The pipeline in order. 'edit' loops back to 'seo_review' at runtime, so the
 * order a run actually takes is not linear - this list is: it is the canonical
 * answer to "is stage X downstream of stage Y", which is what decides whether
 * a stored output was superseded by a re-run of something before it.
 */
export const STAGE_ORDER: readonly Stage[] = [
  'research',
  'keyword',
  'angle',
  'outline',
  'write',
  'seo_review',
  'edit',
  'assemble',
  'image',
  'publish',
  'done',
];

export type ArticleStatus =
  | 'queued'
  | 'running'
  | 'failed'
  /**
   * The stage ran out of wall-clock time, or the worker holding it stopped
   * reporting. Terminal and deliberately distinct from 'failed': nothing
   * reported an error, so "failed" would send an operator looking for one -
   * what actually happened is that the run was stopped, and whatever it had
   * already written is still on the article as a draft.
   */
  | 'timed_out'
  | 'waiting_approval'
  | 'cancelled'
  | 'done';

/** Status of one agent_sessions row. Mirrors ArticleStatus's timeout state. */
export type SessionStatus = 'running' | 'done' | 'failed' | 'timed_out';

/** Why a stage stopped: it spent its budget, or its lease went unrenewed. */
export type StageTimeoutCause = 'budget' | 'lease';

/**
 * What an operator needs to know about a stopped stage, and the payload the
 * error message is built from.
 */
export interface StageTimeoutDetail {
  agent: string;
  stage: Stage;
  budgetSeconds: number;
  elapsedSeconds: number;
  /**
   * The last LLM call the stage started, rendered for a human ("claude-opus-5
   * with web search, retry 2 of 3, in flight for 41m"). Null or empty when the
   * stage had not reached a model yet, or when the run was reaped by another
   * process that cannot see what it was doing.
   */
  lastCall: string | null;
  /**
   * Named apart from the standard `Error.cause` on the class below, which by
   * convention carries the underlying error rather than a discriminator.
   */
  timeoutCause: StageTimeoutCause;
}

/**
 * A stage stopped by its wall-clock budget. Carries the detail rather than
 * only a message so callers route on the type (a timeout is not a failure)
 * without parsing text. The message is built - and scrubbed - by
 * pipeline/stageTimeout.ts, which is the only thing that should construct one.
 */
export class StageTimeoutError extends Error {
  readonly agent: string;
  readonly stage: Stage;
  readonly budgetSeconds: number;
  readonly elapsedSeconds: number;
  readonly lastCall: string | null;
  readonly timeoutCause: StageTimeoutCause;

  constructor(message: string, detail: StageTimeoutDetail) {
    super(message);
    this.name = 'StageTimeoutError';
    this.agent = detail.agent;
    this.stage = detail.stage;
    this.budgetSeconds = detail.budgetSeconds;
    this.elapsedSeconds = detail.elapsedSeconds;
    this.lastCall = detail.lastCall || null;
    this.timeoutCause = detail.timeoutCause;
  }
}

export interface ArticleRow {
  id: string;
  topic_id: string | null;
  title: string;
  slug: string | null;
  category: string;
  post_type: string;
  stage: Stage;
  status: ArticleStatus;
  revision_round: number;
  research: ResearchDossier | null;
  /** Live SERP read: which keyword we're built to win, and what it takes. */
  keyword_plan: KeywordPlan | null;
  /** What the piece argues, who for, and the shape that argument takes. */
  editorial_angle: EditorialAngle | null;
  /**
   * The silhouette this piece was built to, from the structure library. The
   * record of a decision: which sections it carries, how they are ordered and
   * named, how many extractable passages it spends. Null for articles outlined
   * before the library existed - every consumer treats that as the old
   * universal skeleton.
   */
  structure_shape: StructureShape | null;
  outline: ContentBrief | null;
  draft_md: string | null;
  seo_review: SeoReview | null;
  frontmatter: Record<string, unknown> | null;
  affiliate_links: AffiliateLinkRow[] | null;
  /**
   * Operator-supplied hero image (dropped in the admin panel). Set, it wins
   * over anything the image agent finds or generates: the assembler stamps it
   * into frontmatter on every pass and the image stage skips itself.
   */
  hero_image_url: string | null;
  hero_alt: string | null;
  /**
   * Where the hero image came from: 'operator' (dropped in the admin panel),
   * 'found' (a third party's photograph the image agent vetted) or 'generated'
   * (ours). Null on articles that ran before the column existed, and on any
   * article with no hero at all.
   *
   * A value rather than a sentence in the image stage's summary because it is
   * read as a rights decision: only a hero we generated may be uploaded
   * natively to a social network.
   */
  hero_image_source: HeroImageSource | null;
  /** Admin feedback awaiting application — consumed (cleared) by the editor stage. */
  feedback: string | null;
  /**
   * Set while this article is a rebuild of a page that is already live: the
   * slug, angle and body the requalification started from. Null on a normal
   * article. Its presence is what locks the slug and what makes the assembler
   * keep the original publication date.
   */
  requalification: RequalificationSource | null;
  error: string | null;
  /**
   * The claim on this article: which worker is running its current stage and
   * when it took it. NULL while the article is not claimed.
   */
  claimed_by: string | null;
  claimed_at: string | null;
  /**
   * Lease bookkeeping for the stage this article is currently claimed for, all
   * NULL while it is not claimed. The worker renews both while it works; a
   * claim whose `lease_expires_at` has passed is reaped to 'timed_out'.
   */
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  /**
   * Which pass over this article is current: the first pipeline run is 1, and
   * a retry increments it. A claim does not - two claims of the same queued
   * article are one attempt that was interrupted, not two.
   */
  attempt: number;
  /**
   * The earliest stage whose stored output has been superseded by a retry, so
   * everything after it in STAGE_ORDER reads as out of date until the run
   * passes it again. Written by the retry endpoints, never by the runner.
   */
  stale_from_stage: Stage | null;
  /** Publication date, stamped on the first publish and reused on every later pass. */
  pub_date: string | null;
  /** Digest of what was last published, so a repeat publish can skip the rebuild dispatch. */
  published_digest: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A markdown reference the operator supplied (uploaded file or pasted block). */
export interface ReferenceMaterial {
  name: string;
  content: string;
}

/**
 * The live page a requalification started from.
 *
 * A published article goes back through the whole pipeline - research, angle,
 * outline, write, review, assemble, publish - and comes out at the same
 * address. That only works if the things which make it *that page* survive the
 * round trip, so they are captured once, when the operator asks for it, and
 * read back at the three stages that would otherwise lose them: the researcher
 * (which needs to know what is already there), the outliner (which is refused
 * permission to move the slug) and the assembler (which keeps the original
 * publication date and protects the live /go/ rows).
 */
export interface RequalificationSource {
  /** The published slug. Locked: the rebuild republishes this page, not a new one. */
  slug: string;
  /** The live title, for the operator reading the session line. */
  title: string;
  /** What the live page argued, as precisely as the platform can state it. */
  angle: string;
  /** The live body at the moment requalification was requested. */
  body: string;
  /** The original publication date. Kept, with updatedDate stamped alongside. */
  pubDate: string | null;
  /** /go/ slugs the live body carried - their destinations have to survive. */
  goSlugs: string[];
  requestedAt: string;
}

export interface TopicRow {
  id: string;
  title: string;
  category: string;
  post_type: string;
  angle: string | null;
  keywords: string[];
  why_trending: string | null;
  sources: string[];
  status: string;
  /** 'scout' | 'manual' — manual topics carry an operator brief below. */
  source: string;
  /** Operator's free-text brief for a manual topic (null for scouted topics). */
  instructions: string | null;
  /** Operator-supplied markdown references, treated as authoritative context. */
  research_notes: ReferenceMaterial[];
  /** Hero image attached at brief time — copied onto the article on approval. */
  hero_image_url: string | null;
  hero_alt: string | null;
}

export interface TopicSuggestion {
  title: string;
  category: string;
  postType: string;
  angle: string;
  keywords: string[];
  whyTrending: string;
  sources: string[];
}

/**
 * Where a claim came from, and therefore what it is worth. The researcher
 * gathers in these strata and every fact is filed under one, because a spec
 * off the maker's own page and a number lifted from someone's roundup are not
 * the same evidence and must never be averaged into one undifferentiated list.
 *
 * 'unknown' is deliberate: a fact whose source we could not place is marked as
 * such rather than quietly promoted to the tier around it.
 */
export type SourceTier = 'primary' | 'expert' | 'owner' | 'aggregator' | 'unknown';

export interface DossierFact {
  fact: string;
  sourceUrl: string;
  tier: SourceTier;
  /** The date the source carries (YYYY, YYYY-MM or YYYY-MM-DD); null when undated. */
  date: string | null;
  /** Who said it, in a reader's words ("Choice", "Rtings", "Sony"); null when unnamed. */
  publisher: string | null;
}

/** How much of the owner corpus a complaint speaks for. */
export type ComplaintVolume = 'isolated' | 'recurring' | 'widespread' | 'unknown';

/**
 * How the complaint was reported: 'aggregate' is a published fault rate over a
 * stated sample (Choice's member surveys report ownership this way), 'quoted'
 * is what individual owners wrote. The distinction matters because one
 * aggregate rate is better evidence than any number of picked-out quotes.
 */
export type ComplaintKind = 'quoted' | 'aggregate';

/**
 * What owners say goes wrong. This is the material a spec sheet cannot supply
 * and the reason the research stage exists in this shape: volume separates one
 * angry review from a pattern, recency separates a fixed fault from a live one.
 */
export interface OwnerComplaint {
  product: string;
  complaint: string;
  volume: ComplaintVolume;
  /** When owners were saying it (YYYY, YYYY-MM or YYYY-MM-DD); null when undated. */
  recency: string | null;
  /**
   * How many owners said it, out of how many: "37 of 412 reviews",
   * "1,076 owners surveyed". Null when the source publishes no denominator -
   * and a complaint without one does not count toward the evidence bar.
   */
  denominator: string | null;
  kind: ComplaintKind;
  sourceUrl: string;
}

/** What breaks, and how long it takes. */
export interface FailureMode {
  product: string;
  failure: string;
  /** In owners' words: "after 6-12 months", "within the first week". */
  timeframe: string;
  sourceUrl: string;
  tier: SourceTier;
}

/** A buyer this product is wrong for, and why. */
export interface BuyerExclusion {
  audience: string;
  reason: string;
  sourceUrl: string;
}

/**
 * A price seen at a named retailer on a named day. Never printed as an Amazon
 * price (the editorial rules forbid that); it is here so the piece can say
 * what a product has cost and whether it is moving.
 */
export interface PriceObservation {
  product: string;
  value: number;
  /** ISO 4217 code, or 'unknown' when the source did not say. */
  currency: string;
  retailer: string;
  /** YYYY-MM-DD the price was seen; null when the source gives no date. */
  dateChecked: string | null;
  sourceUrl: string;
}

/** A measured result somebody published, with who measured it and when. */
export interface TestedClaim {
  claim: string;
  /** Who ran the test, named. */
  source: string;
  year: number | null;
  sourceUrl: string;
}

/**
 * A headline figure, and where the number came from - the record behind the
 * three tier labels a page prints beside every claim it makes.
 *
 * One row holds both halves of a disputed spec deliberately. A maker's figure
 * and an independent measurement of the same metric are one fact about the
 * product, not two, and the pattern the category leaders use is to show them
 * side by side with each side's conditions named. Dropping the maker's number
 * is not an option either: the reader arrived having already seen it, and the
 * gap is the most useful thing on the page.
 */
export interface MeasuredClaim {
  /** The product this figure describes, named the way the page names it. */
  subject: string;
  /** What was measured: "Battery life, screen-on", "Peak brightness". */
  metric: string;
  /** The maker's own figure, as published; null when the maker publishes none. */
  claimedValue: string | null;
  /** Who published the claim - the brand. Null when there is no claim. */
  claimedBy: string | null;
  claimedSourceUrl: string | null;
  /** The conditions the maker states for its own figure, where it states any. */
  claimedConditions: string | null;
  /** The independently measured figure; null when nobody has measured it yet. */
  measuredValue: string | null;
  /** Who measured it, named ("GSMArena", "Notebookcheck", "SleekDrops"). */
  measuredBy: string | null;
  /** The protocol the measurement was taken under, in the tester's words. */
  conditions: string | null;
  /** YYYY, YYYY-MM or YYYY-MM-DD the measurement published; null when undated. */
  measuredOn: string | null;
  measuredSourceUrl: string | null;
  /**
   * A figure this tester has since withdrawn, kept beside the corrected one.
   * A correction the reader cannot see is indistinguishable from a number we
   * quietly changed.
   */
  withdrawnValue: string | null;
  /** True only when we ran the test ourselves - the one route to tier 1. */
  ownTest: boolean;
  /**
   * What the source's result actually covers, in the source's own terms - "the
   * Smart Home Appliances brand survey, 2026", "the 12 models CHOICE tested in
   * March". Load-bearing for brand-level and cohort raters, whose rating is
   * evidence about a survey or a cohort and not about every model in it.
   */
  covers: string | null;
}

/**
 * When the product a piece is about actually went on sale, and therefore
 * whether the piece is being written inside the launch window.
 *
 * Inside it, no Australian lab result exists by design: CHOICE runs phone
 * tests through ICRT labs in Europe and publishes weeks to months after
 * launch, Canstar Blue is a brand-level satisfaction survey, and
 * ProductReview is owner reviews. Holding a launch piece to a local lab test
 * does not produce one, it produces a piece that never ships.
 */
export interface LaunchRelease {
  /** The product whose release date sets the window. */
  product: string;
  /** YYYY-MM-DD it went on sale in Australia; null when we could not date it. */
  releaseDate: string | null;
  /** Where the date came from. */
  sourceUrl: string;
}

/** How a review unit was obtained - the disclosure the ACCC sweep found missing most often. */
export interface ReviewUnit {
  /** 'retail' bought, 'loan' supplied by the brand, 'none' no unit at all. */
  acquisition: 'retail' | 'loan' | 'none';
  /** The brand or PR agency that lent the unit; null on a bought or absent unit. */
  supplier: string | null;
  /** What we paid, as a reader reads it ("A$1,699"); null when we paid nothing. */
  paid: string | null;
  /** Month and year the loan unit went back ("2026-09"); null when it has not. */
  returned: string | null;
}

/** One stratum that came up short, and what to do about it. */
export interface EvidenceShortfall {
  stratum: string;
  label: string;
  have: number;
  need: number;
  fix: string;
}

/**
 * The deterministic evidence gate's verdict, stamped onto the dossier after
 * synthesis so an operator can see the evidence density a piece was written
 * from - and, when it falls short, exactly which stratum was thin.
 */
export interface EvidenceSufficiency {
  pass: boolean;
  postType: string;
  counts: Record<string, number>;
  shortfalls: EvidenceShortfall[];
  /** Operator-facing: what is missing and what to do next. */
  message: string;
  checkedAt: string;
}

export interface ResearchDossier {
  summary: string;
  facts: DossierFact[];
  products: Array<{
    name: string;
    brand: string;
    approxPrice: string;
    amazonUrl: string | null;
    goSlug: string;
    notes: string;
  }>;
  /** What breaks after the honeymoon, from owner and long-term coverage. */
  failureModes: FailureMode[];
  /** Buyers this product is wrong for - the honest half of a recommendation. */
  whoShouldNotBuy: BuyerExclusion[];
  ownerComplaints: OwnerComplaint[];
  priceObservations: PriceObservation[];
  testedClaims: TestedClaim[];
  /**
   * The headline figures, each with the number and where it came from. The
   * page's tier labels and its claimed-vs-measured cards are rendered from
   * these and from nothing else.
   */
  claims?: MeasuredClaim[];
  /** Set only when the piece is about a product released recently. */
  launch?: LaunchRelease | null;
  /** How the unit under review was obtained, when there was a unit at all. */
  reviewUnit?: ReviewUnit | null;
  keywords: { primary: string; secondary: string[] };
  competitorNotes: string;
  faqIdeas: Array<{ question: string; answerHint: string }>;
  /** Stamped by the evidence gate at the end of research; absent on pre-gate dossiers. */
  sufficiency?: EvidenceSufficiency;
}

/**
 * Output of the keyword strategist — a keyword-deep-dive over the live SERP
 * rather than a guess from the dossier. Everything downstream (brief, draft,
 * review) is built against this, so the piece targets a query we can actually
 * win instead of the prettiest phrase in the research.
 */
export interface KeywordPlan {
  /** The one query the piece is built to rank for. */
  primaryKeyword: string;
  /** Why this candidate beat the others we checked. */
  rationale: string;
  /** Informational | Commercial Investigation | Transactional | Navigational */
  intent: string;
  /** Read off the SERP competition, not a tool score. */
  difficulty: 'Easy' | 'Moderate' | 'Hard';
  /** How much of this query's traffic never leaves Google. */
  zeroClickRisk: 'Low' | 'Medium' | 'High';
  /** Featured snippet, People Also Ask, AI Overview, image pack, ... */
  serpFeatures: string[];
  /** The content type the SERP rewards — match it or lose. */
  winningFormat: string;
  /** Average length of the top results plus ~10%. */
  wordCountTarget: number;
  secondaryKeywords: string[];
  /** Long-tail questions to answer as H2/H3 with an extractable block. */
  paaQuestions: string[];
  /** Named things the top pages cover; naming them is what GEO rewards. */
  entities: string[];
  competitors: Array<{ url: string; format: string; angle: string; strength: string }>;
  /** Subtopics the top results handle badly — our information gain. */
  contentGaps: string[];
  /** The extractable answer block we're trying to win the snippet with. */
  snippetTarget: { question: string; format: 'paragraph' | 'list' | 'table'; answer: string };
  /** What a generative engine says about this query today, if we saw one. */
  currentAiAnswer: string;
  titleOptions: string[];
  metaDescription: string;
  /** Candidates that lost, and why — shown in the admin panel. */
  rejected: Array<{ keyword: string; reason: string }>;
}

/**
 * The structural shapes a piece may take. The list exists to stop every
 * article on the site coming out of one skeleton: a "best X" guide that opens
 * with the winner and defends it is a different document from one that splits
 * by buyer, and a reader who reads two of ours should not feel the same
 * silhouette under both.
 *
 * The value is a one-line description because it is rendered straight into the
 * outliner's prompt - the shape has to arrive as an instruction, not as an id.
 */
export const ARTICLE_SHAPES = {
  'verdict-first':
    'Open with the single pick and spend the piece defending it; every other contender is a counter-argument to answer.',
  'segmented-buyers':
    'One section per kind of buyer. The pick changes per segment and the piece says who each one is wrong for.',
  'head-to-head':
    'Two or three contenders argued against each other, axis by axis, on the things that actually decide it.',
  'failure-led':
    'Lead with what goes wrong and how long it takes to go wrong; the recommendation is whatever survives that.',
  'cost-of-ownership':
    'Lead with what the thing costs over its life - RRP, consumables, warranty, resale - and rank on that.',
  'question-led':
    'Walk the reader question chain in the order a buyer actually asks it, answering each before the next.',
  'ranked-list':
    'A ranked list with the scoring rationale stated - only when the SERP genuinely rewards a list and nothing else fits.',
} as const;

export type ArticleShape = keyof typeof ARTICLE_SHAPES;

/**
 * A shape we actually publish. `Object.hasOwn`, not `in`: a record read back
 * out of JSONB carries whatever string is in the column, and `'constructor' in
 * ARTICLE_SHAPES` is true.
 */
export function isArticleShape(value: unknown): value is ArticleShape {
  return typeof value === 'string' && Object.hasOwn(ARTICLE_SHAPES, value);
}

/** The shape as an instruction, for a prompt or the panel. Empty when unknown. */
export function describeArticleShape(shape: string): string {
  return isArticleShape(shape) ? ARTICLE_SHAPES[shape] : '';
}

/** One thing this piece says that a named top-3 result does not, and its proof. */
export interface InformationGain {
  /** The claim, in the piece's own words. */
  claim: string;
  /** The competitor URL that does not carry it, from the keyword plan. */
  absentFrom: string;
  /** What in the dossier supports it - a fact, a complaint, a failure mode. */
  evidence: string;
}

/**
 * What the piece argues, decided before a word of it is written.
 *
 * This stage exists because coverage is not curation. The outliner turns a
 * dossier into sections and the writer fills them, and the result reads as
 * complete and says nothing - which is exactly what a human reviewer calls
 * "automatically generated material lacking meaningful review or curation".
 * A thesis recorded up front is the thing every later stage can be held to.
 *
 * `defensible: false` is a first-class outcome, not a failure. Some topics
 * genuinely have no contrarian take the evidence supports, and a fabricated
 * one is worse than none: it is an invented position defended with invented
 * reasons. A piece recorded as indefensible competes on evidence instead, and
 * says so to every downstream stage.
 */
export interface EditorialAngle {
  /** The one arguable claim the piece makes. A sentence someone could dispute. */
  thesis: string;
  /** The specific reader served - a situation, not a demographic. */
  reader: string;
  /** The non-obvious or contrarian take, grounded in the dossier. Empty when there is none. */
  contrarianTake: string;
  /** True when the evidence supports a real position; false records that it does not. */
  defensible: boolean;
  /** When not defensible: what the evidence was missing. Empty otherwise. */
  weakness: string;
  /** What we say that the top-3 results do not. */
  informationGain: InformationGain[];
  /** The structural shape the piece takes, from ARTICLE_SHAPES. */
  shape: ArticleShape;
  /** Why this shape beats the others for this thesis and this SERP. */
  shapeRationale: string;
  /** The beat voice the angle commissions this in - an id from the author registry. */
  byline: string;
  /** Why that beat's voice fits this thesis and this subject. */
  bylineRationale: string;
}

export interface ContentBrief {
  seoTitle: string;
  dek: string;
  slug: string;
  author: string;
  kind: string;
  searchIntent: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  tags: string[];
  wordCountTarget: number;
  sections: Array<{
    heading: string;
    points: string[];
    /** The structure-library section kind this heading executes, when a shape drove it. */
    kind?: string;
    /**
     * True when this section spends one of the article's extractable passages.
     * Capped at the shape's passage budget by the outliner, so the flag is a
     * decision the writer can be held to rather than a hint.
     */
    extractable?: boolean;
  }>;
  faq: Array<{ question: string }>;
  /**
   * The structure library shape this brief executes. Optional: a brief written
   * before the library existed carries none, and every prompt that reads one
   * falls back to the universal skeleton. Embedded in the brief (as well as
   * living in its own column) because the writer and the SEO reviewer both
   * serialise the whole brief into their prompt, so this is what carries the
   * shape downstream.
   */
  structureShape?: StructureShape;
}

export interface SeoReview {
  score: number;
  pass: boolean;
  issues: Array<{ severity: 'high' | 'medium' | 'low'; issue: string; fix: string }>;
  summary: string;
  /**
   * Per-dimension scores. One number hid which axis was failing, so an editor
   * pass had to guess.
   *
   * The axes are what a demanding editor would grade, not what our own writing
   * rules cover: the old set (seo, geo, voice, eeat, links) scored the draft
   * against the checklist the writer was handed, which rewarded conformity to
   * the template. Voice left the set entirely - the deterministic scanner
   * measures it, and the composite is capped by that score.
   *
   * Optional, and reviews written before the restructure carry the old keys.
   * Every consumer renders whatever keys it finds rather than naming them.
   */
  dimensions?: {
    /** Specifics traceable to the dossier, sourced by name, dated where it matters. */
    evidence: number;
    /** Does the piece argue something and pay for it - real cons, a named loser. */
    position: number;
    /** Fit to the structure shape it was commissioned in, not the house skeleton. */
    structure: number;
    /** What a generative engine can lift: extractable answers, entities, FAQ, recency. */
    citability: number;
    /** /go/ link contract and placement rules. */
    links: number;
  };
  /** Deterministic anti-slop scan, run before the model sees the draft. */
  slop?: { score: number; words: number; findings: number };
  /**
   * What this piece gives a reader that the keyword plan's captured top
   * results do not. Absent when the plan captured no competitors to grade
   * against, and on reviews written before the delta pass existed.
   */
  competitorDelta?: {
    comparedWith: string[];
    additions: Array<{ claim: string; absentFrom: string; evidence: string }>;
    duplicated: string[];
    verdict: 'adds-substantially' | 'adds-marginally' | 'adds-nothing';
    notes: string;
  };
  /** Specifics checked against the dossier; the unsupported ones are filed as issues. */
  claimAudit?: { checked: number; unsupported: number };
  /** Whether the piece argues anything, and whether its cons cost the buyer something. */
  positionCheck?: {
    takesStance: boolean;
    stance: string;
    recommendsEverythingEqually: boolean;
    picks: Array<{ pick: string; cons: string[]; hedged: boolean }>;
    notes: string;
  };
  /** Set by the runner when revision rounds ran out but we shipped anyway. */
  forcedThrough?: boolean;
}

/**
 * Payload for the affiliate_links.regions_json column. Structured keys drive
 * the region-aware Amazon builder in apps/web/functions/_lib/affiliates.mjs;
 * any other key is a per-region literal URL (legacy rows).
 */
export interface AffiliateRegions {
  network?: 'amazon';
  /** Search term for marketplaces without a verified ASIN — never 404s. */
  search?: string;
  /** Marketplace-specific ASINs, only for regions they were verified on. */
  asins?: Record<string, string>;
  [regionUrl: string]: unknown;
}

export interface AffiliateLinkRow {
  slug: string;
  default_url: string;
  regions_json?: AffiliateRegions | null;
  note?: string;
  /**
   * Rebuilt from the draft (its link text or its slug) because no dossier
   * product stood behind it: a search destination, never a verified ASIN.
   *
   * `affiliate_links` is a site-wide slug → destination map and a product slug
   * is deterministic, so the row for this slug may already belong to another
   * article that resolved it properly. The publisher therefore only inserts a
   * healed row where the slug is still free - a guess never overwrites a
   * dossier-backed destination. Pipeline-side only: D1 has no such column.
   */
  healed?: boolean;
  /**
   * Set when the destination came from an attached offer record rather than
   * from the dossier. A human (or, later, the feed that took that record over)
   * chose this URL, which is why it may point outside the Amazon marketplaces
   * the pipeline is allowed to build destinations for on its own.
   *
   * Pipeline-side only, like `healed`: D1 has no such column.
   */
  manual?: boolean;
  /**
   * A destination the live site already has, which this pass must not
   * downgrade. Set during a requalification for a /go/ slug the published body
   * already carried when this pass could not verify an ASIN of its own: the
   * row in D1 may hold a marketplace-verified product destination, and
   * overwriting it with a search link would break the very link the rebuild
   * was supposed to preserve. Like `healed`, it only ever fills a slug nothing
   * has claimed - and unlike `healed`, the slug it is protecting is one we
   * know is claimed, by this article's own published version.
   */
  preserved?: boolean;
}

/**
 * Who supplied an offer record, and therefore what its price is worth.
 *
 * 'editor' is a person typing what they can see on the merchant's page on
 * announcement day. 'feed' and 'api' are the automated sources that take that
 * record over once the merchant has published the SKU - later, better data for
 * the same product, which is why they overwrite rather than sit beside it.
 */
export type OfferSource = 'editor' | 'feed' | 'api';

export const OFFER_SOURCES: readonly OfferSource[] = ['editor', 'feed', 'api'];

/**
 * One product's offer on one article: where the reader is sent, what it cost,
 * and when that price was seen.
 *
 * A launch-window SKU carries no feed row and cannot be polled through the
 * Product Advertising API, so this record is the only thing standing between
 * "announced today" and "has a real commissionable link today". `price` is
 * nullable because a link with no price is still a link, and a figure invented
 * to fill the column is exactly the misstatement the "as at" stamp exists to
 * prevent.
 *
 * Dates are read as YYYY-MM-DD strings (see db/offers.ts) rather than as
 * Date objects: what the reader is shown is a day, in the publication's own
 * timezone, and a Date would drag the server's one into it.
 */
export interface ProductOffer {
  id: string;
  article_id: string;
  go_slug: string;
  product_name: string;
  url: string;
  /** NUMERIC, read back as a string so no cents are lost in a float. */
  price: string | null;
  currency: string;
  price_observed_on: string | null;
  preorder: boolean;
  release_date: string | null;
  merchant: string | null;
  source: OfferSource;
  entered_by: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** One version of an offer as it was saved, newest first in the panel. */
export interface ProductOfferRevision {
  id: string;
  go_slug: string;
  url: string;
  price: string | null;
  currency: string;
  price_observed_on: string | null;
  preorder: boolean;
  release_date: string | null;
  merchant: string | null;
  source: OfferSource;
  entered_by: string | null;
  saved_at: string;
}

/** The editable half of an offer - what a save writes. */
export interface OfferInput {
  goSlug: string;
  productName: string;
  url: string;
  price: string | null;
  currency: string;
  priceObservedOn: string | null;
  preorder: boolean;
  releaseDate: string | null;
  merchant: string | null;
  source: OfferSource;
  enteredBy: string;
  note?: string | null;
}
