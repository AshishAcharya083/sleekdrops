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

export const ASIN_RE = /^[A-Z0-9]{10}$/;

// regions_json rides through D1 → fetch-content.mjs → the /go/ resolver, which
// spreads it into the link entry. Structured keys (network/search/asins) drive
// the region-aware Amazon builder; any other key is a per-region literal URL.
export const affiliateRegionsSchema = z
  .object({
    network: z.literal('amazon').optional(),
    search: z.string().min(1).optional(),
    asins: z.record(z.string().regex(ASIN_RE)).optional(),
  })
  .catchall(z.string().url());

export const affiliateLinkSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  default_url: z.string().url(),
  regions_json: affiliateRegionsSchema.nullable().optional(),
  note: z.string().optional(),
});

export type AffiliateLink = z.infer<typeof affiliateLinkSchema>;

// Same regexes the site build enforces (fetch-content.mjs).
export const RAW_MERCHANT = /(amazon\.[a-z.]+\/(dp|gp\/product)\/|amzn\.to\/|[?&]tag=)/i;
export const GO_LINK = /\/go\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

// ---------------------------------------------------------------------------
// Approved merchants. Amazon is currently the ONLY network we're enrolled in;
// an affiliate row pointing anywhere else is a contract violation (this is
// what let a news.com.au URL slip into production once). Mirrors the region
// model in apps/web/functions/_lib/affiliates.mjs — the resolver owns the
// storefront hosts + Associates tags, the pipeline only ships ASINs/searches.
// ---------------------------------------------------------------------------
export const AMAZON_MARKETPLACES = {
  au: 'www.amazon.com.au',
  us: 'www.amazon.com',
} as const;
export type AmazonRegion = keyof typeof AMAZON_MARKETPLACES;
/** Primary audience market — search fallbacks and default_url use this. */
export const HOME_REGION: AmazonRegion = 'au';

/** Parse an Amazon PRODUCT url into its marketplace + ASIN, else null. */
export function parseAmazonUrl(url: string): { region: AmazonRegion; asin: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const region = (Object.entries(AMAZON_MARKETPLACES) as Array<[AmazonRegion, string]>).find(
    ([, h]) => h.replace(/^www\./, '') === host,
  )?.[0];
  if (!region) return null;
  const m = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (!m) return null;
  return { region, asin: m[1].toUpperCase() };
}

/**
 * Amazon search-results URL — the "never 404s" destination. Deliberately
 * carries NO Associates tag: tags are per-marketplace credentials owned by
 * the redirect resolver (functions/_lib/affiliates.mjs), never stored in data.
 */
export function amazonSearchUrl(term: string, region: AmazonRegion = HOME_REGION): string {
  return `https://${AMAZON_MARKETPLACES[region]}/s?k=${encodeURIComponent(term)}`;
}

/** True when a URL points at an approved merchant (any Amazon marketplace we use). */
export function isApprovedMerchantUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return Object.values(AMAZON_MARKETPLACES).some((h) => h.replace(/^www\./, '') === host);
  } catch {
    return false;
  }
}

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

  // Merchant allowlist — every destination must be an approved marketplace.
  for (const link of parsedLinks) {
    if (!isApprovedMerchantUrl(link.default_url)) {
      problems.push(`/go/${link.slug}: default_url is not an approved merchant (Amazon only): ${link.default_url}`);
    }
    for (const [key, value] of Object.entries(link.regions_json ?? {})) {
      if (['network', 'search', 'asins'].includes(key)) continue;
      if (typeof value === 'string' && !isApprovedMerchantUrl(value)) {
        problems.push(`/go/${link.slug}: region "${key}" URL is not an approved merchant: ${value}`);
      }
    }
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
