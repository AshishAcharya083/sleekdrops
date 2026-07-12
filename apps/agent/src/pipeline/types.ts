// Row shapes and inter-agent data contracts (the session.state equivalents).

export type Stage =
  | 'research'
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
  outline: ContentBrief | null;
  draft_md: string | null;
  seo_review: SeoReview | null;
  frontmatter: Record<string, unknown> | null;
  affiliate_links: AffiliateLinkRow[] | null;
  /** Admin feedback awaiting application — consumed (cleared) by the editor stage. */
  feedback: string | null;
  error: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
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
