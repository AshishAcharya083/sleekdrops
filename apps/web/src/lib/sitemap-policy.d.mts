/** Types for the plain-ESM sitemap policy in ./sitemap-policy.mjs. */

export const MIN_TAG_POSTS: number;
export function isIndexableTag(postCount: number): boolean;
export function slugify(text: string): string;
export function parseFrontmatter(markdown: string): Record<string, unknown> | null;

export interface PostRecord {
  slug: string;
  pubDate: Date | null;
  updatedDate: Date | null;
  tags: string[];
  category: string;
  author: string;
  postType: string;
  live: boolean;
}

export function toPostRecord(slug: string, data: Record<string, unknown>, now?: Date): PostRecord;
export function readContentIndex(blogDir: string, now?: Date): PostRecord[];
export function latestChange(posts: PostRecord[]): string | undefined;

export interface SitemapItem {
  url: string;
  lastmod?: string;
  [key: string]: unknown;
}

export interface SitemapPolicy {
  lastmodFor(path: string): string | undefined;
  filter(url: string): boolean;
  serialize<T extends SitemapItem>(item: T): T;
}

export function createSitemapPolicy(posts: PostRecord[]): SitemapPolicy;
