// The content contract between the agent pipeline and the website.
// Mirrors apps/web/src/content/config.ts (Astro Zod schema) and the body
// guardrails in apps/web/scripts/fetch-content.mjs — if either changes,
// change this too, or published rows will fail the site build.
import { z } from 'zod';

export const CATEGORIES = ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel'] as const;

// `review` is deliberately absent: reviews require hands-on testing and are
// human-driven per the editorial rules. The pipeline writes the other three.
export const POST_TYPES = ['article', 'guide', 'roundup'] as const;

export const AUTHORS = [
  { id: 'mira', name: 'Mira Kapoor', beat: 'Senior reviews editor — home, general product testing' },
  { id: 'theo', name: 'Theo Renn', beat: 'Audio & tech' },
  { id: 'aiko', name: 'Aiko Tanaka', beat: 'Health & wearables' },
  { id: 'lina', name: 'Lina Voss', beat: 'Fashion & textiles' },
  { id: 'sam', name: 'Sam Ortiz', beat: 'Personal finance' },
  { id: 'beatriz', name: 'Beatriz Lima', beat: 'Travel & gear' },
] as const;

export const frontmatterSchema = z.object({
  title: z.string().min(1),
  dek: z.string().min(1),
  category: z.enum(CATEGORIES),
  postType: z.enum(POST_TYPES),
  kind: z.string().optional(),
  author: z.enum(AUTHORS.map((a) => a.id) as [string, ...string[]]),
  tags: z.array(z.string()).min(1),
  pubDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updatedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  readTime: z.number().int().positive(),
  cover: z.enum(['fill-1', 'fill-2', 'fill-3', 'fill-4', 'fill-5', 'fill-6', 'fill-7', 'fill-8']),
  heroImage: z.string().url().optional(),
  heroAlt: z.string().optional(),
  featured: z.boolean().default(false),
  draft: z.boolean().default(false),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export const affiliateLinkSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  default_url: z.string().url(),
  regions_json: z.record(z.string().url()).nullable().optional(),
  note: z.string().optional(),
});

export type AffiliateLink = z.infer<typeof affiliateLinkSchema>;

// Same regexes the site build enforces (fetch-content.mjs).
export const RAW_MERCHANT = /(amazon\.[a-z.]+\/(dp|gp\/product)\/|amzn\.to\/|[?&]tag=)/i;
export const GO_LINK = /\/go\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function goSlugsIn(body: string): string[] {
  return [...new Set([...body.matchAll(GO_LINK)].map((m) => m[1]))];
}

export function estimateReadTime(body: string): number {
  const words = body.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

/** Deterministic cover art choice so re-runs don't churn. */
export function pickCover(slug: string): Frontmatter['cover'] {
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `fill-${(hash % 8) + 1}` as Frontmatter['cover'];
}

/**
 * Deterministic pre-publish validation (never trust the LLM on this):
 * returns a list of problems, empty when the article is safe to publish.
 */
export function validateArticle(
  body: string,
  frontmatter: unknown,
  links: unknown[],
): string[] {
  const problems: string[] = [];

  const fm = frontmatterSchema.safeParse(frontmatter);
  if (!fm.success) {
    problems.push(...fm.error.issues.map((i) => `frontmatter.${i.path.join('.')}: ${i.message}`));
  }

  const parsedLinks: AffiliateLink[] = [];
  for (const link of links) {
    const parsed = affiliateLinkSchema.safeParse(link);
    if (parsed.success) parsedLinks.push(parsed.data);
    else problems.push(`affiliate link invalid: ${JSON.stringify(link).slice(0, 120)}`);
  }

  if (RAW_MERCHANT.test(body)) {
    problems.push('body contains a raw merchant URL — every outbound link must be /go/<slug>');
  }
  const linkSlugs = new Set(parsedLinks.map((l) => l.slug));
  for (const slug of goSlugsIn(body)) {
    if (!linkSlugs.has(slug)) {
      problems.push(`/go/${slug} has no matching affiliate link row`);
    }
  }
  return problems;
}
