/** Types for the plain-ESM llms.txt builder in ./llms-txt.mjs. */

export const CURATED_LIMIT: number;
export const CURATED_PER_CATEGORY: number;
export const MIN_CURATED_WORDS: number;

export const STRENGTH_WEIGHTS: Record<string, number>;

export function plainText(markdown: string): string;
export function splitDocument(markdown: string): { data: Record<string, unknown>; body: string };

export interface ArticleRecord {
  slug: string;
  title: string;
  dek: string;
  category: string;
  postType: string;
  tags: string[];
  pubDate: Date | null;
  updatedDate: Date | null;
  readTime: number | null;
  featured: boolean;
  live: boolean;
  wordCount: number;
  sections: string[];
  questions: string[];
  hasComparisonTable: boolean;
  datedClaims: number;
  specificFigures: number;
  lead: string;
}

/** An article record with its strength score, as both files consume it. */
export type ScoredArticle = ArticleRecord & { score: number };

export function toArticleRecord(
  slug: string,
  data: Record<string, unknown>,
  body: string,
  now?: Date,
): ArticleRecord;

export function strengthSignals(record: ArticleRecord, now?: Date): Record<string, number>;
export function scoreArticle(record: ArticleRecord, now?: Date): number;
export function byStrength(a: ScoredArticle, b: ScoredArticle): number;
export function readArticleIndex(blogDir: string, now?: Date): ScoredArticle[];

export interface CurateOptions {
  limit?: number;
  perCategory?: number;
  minWords?: number;
}

export function curate(articles: ScoredArticle[], options?: CurateOptions): ScoredArticle[];
export function provenanceLine(marker: string, generatedAt: Date, count: number): string;

export interface CategoryEntry {
  name: string;
  slug: string;
  blurb: string;
}

export interface LlmsTxtInput {
  siteName: string;
  siteUrl: string;
  description: string;
  categories: CategoryEntry[];
  articles: ScoredArticle[];
  deployment?: 'production' | 'preview';
  generatedAt?: Date;
  marker: string;
}

export function buildLlmsTxt(input: LlmsTxtInput): string;
export function buildLlmsFullTxt(input: Omit<LlmsTxtInput, 'categories'> & { categories?: CategoryEntry[] }): string;
