// Row shapes and inter-agent data contracts (the session.state equivalents).

export type Stage =
  | 'research'
  | 'keyword'
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

export interface ResearchDossier {
  summary: string;
  facts: Array<{ fact: string; sourceUrl: string }>;
  products: Array<{
    name: string;
    brand: string;
    approxPrice: string;
    amazonUrl: string | null;
    goSlug: string;
    notes: string;
  }>;
  keywords: { primary: string; secondary: string[] };
  competitorNotes: string;
  faqIdeas: Array<{ question: string; answerHint: string }>;
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
