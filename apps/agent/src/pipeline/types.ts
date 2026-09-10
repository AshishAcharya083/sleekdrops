// Row shapes and inter-agent data contracts (the session.state equivalents).

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

export type ArticleStatus =
  | 'queued'
  | 'running'
  | 'failed'
  | 'waiting_approval'
  | 'cancelled'
  | 'done';

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
  /** Admin feedback awaiting application — consumed (cleared) by the editor stage. */
  feedback: string | null;
  error: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A markdown reference the operator supplied (uploaded file or pasted block). */
export interface ReferenceMaterial {
  name: string;
  content: string;
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
  /** The byline the angle calls for - an id from the author registry. */
  byline: string;
  /** Why this desk's voice fits this thesis and this beat. */
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
  sections: Array<{ heading: string; points: string[] }>;
  faq: Array<{ question: string }>;
}

export interface SeoReview {
  score: number;
  pass: boolean;
  issues: Array<{ severity: 'high' | 'medium' | 'low'; issue: string; fix: string }>;
  summary: string;
  /**
   * Per-dimension scores. One number hid which axis was failing, so an editor
   * pass had to guess; these say whether the problem is search, citability,
   * voice, trust or the affiliate contract.
   */
  dimensions?: {
    /** Classic search: keyword placement, headings, intent match, depth. */
    seo: number;
    /** Generative-engine citability: extractable answers, sourcing, entities. */
    geo: number;
    /** Reads human. Mirrors the deterministic anti-slop scan. */
    voice: number;
    /** Experience, expertise, authority, trust. */
    eeat: number;
    /** /go/ link contract and placement rules. */
    links: number;
  };
  /** Deterministic anti-slop scan, run before the model sees the draft. */
  slop?: { score: number; words: number; findings: number };
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
}
