// The content contract between the agent pipeline and the website.
// Mirrors apps/web/src/content/config.ts (Astro Zod schema) and the body
// guardrails in apps/web/scripts/fetch-content.mjs — if either changes,
// change this too, or published rows will fail the site build.
import { z } from 'zod';

export const CATEGORIES = ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel'] as const;

// `review` is deliberately absent: reviews require hands-on testing and are
// human-driven per the editorial rules. The pipeline writes the other three.
export const POST_TYPES = ['article', 'guide', 'roundup'] as const;

/**
 * Search intents the site earns from. A piece written to answer "which should
 * I buy" that ships with nothing to click is the one defect that costs revenue
 * rather than quality, and post_type does not catch it: a `guide` must carry
 * products (the dossier contract enforces that), but a plain `article` may
 * legitimately carry none — a trend or news piece has nothing to link. Whether
 * THIS article is that kind is only knowable once the keyword strategist has
 * read the SERP and named the intent.
 */
export const MONETISED_INTENTS = new Set(['Commercial Investigation', 'Transactional']);

/**
 * How one desk writes, as instructions a writer can actually follow.
 *
 * "Write in Mira's voice" produces the same prose as no instruction at all,
 * because a one-line persona carries no information about sentences. These
 * four fields do: a rhythm to imitate, words to reach for and words to avoid,
 * the question this desk always asks of a product, and a paragraph whose
 * texture the draft is matched against.
 */
export interface AuthorVoice {
  /** Sentence-rhythm habits - lengths, openings, where the desk breaks. */
  rhythm: string;
  /** The vocabulary this desk reaches for, and what it will not write. */
  vocabulary: string;
  /** What it cares about - the thing it checks on every product, always. */
  cares: string;
  /** A paragraph in this desk's voice. The writer matches its texture, not its subject. */
  specimen: string;
}

export interface AuthorProfile {
  id: string;
  name: string;
  beat: string;
  /** Categories this desk owns. Empty means it covers everything (the fallback desk). */
  covers: readonly string[];
  voice: AuthorVoice;
}

/**
 * The bylines the pipeline may publish under.
 *
 * Every one is a team byline, not an invented person: no fictional
 * credentials, no claimed hands-on testing, no biography that would not
 * survive a manual review. What separates them is what a masthead actually
 * separates - a beat and a house voice - which is enough for the byline to
 * change the prose without any of them pretending to be someone.
 */
export const AUTHORS: readonly AuthorProfile[] = [
  {
    id: 'desk',
    name: 'SleekDrops Editorial Desk',
    beat: 'Research-led product coverage across Tech, Home, Fashion, Health, Finance and Travel',
    covers: [],
    voice: {
      rhythm:
        'Medium sentences, 12-22 words, broken by a short one when a verdict lands. Paragraphs of two or three sentences. Never opens two consecutive paragraphs the same way.',
      vocabulary:
        'Plain nouns and concrete verbs. Says "costs", "breaks", "fits" rather than "delivers", "offers", "provides". Writes "we could not confirm" instead of hedging with adverbs.',
      cares:
        'Whether the evidence actually supports the recommendation, and saying plainly where it runs out.',
      specimen:
        'The V15 is the one to buy if your floors are mostly hard. Choice measured 210AW on the high setting in 2026, and the run time holds up for a two-bedroom flat. Past that it stops being sensible: owners on ProductReview report the battery down to nine minutes by the second year, on 37 of 412 reviews. Carpet-heavy houses should look at the mains-powered options instead.',
    },
  },
  {
    id: 'tech-desk',
    name: 'SleekDrops Tech Desk',
    beat: 'Audio, computing, mobile, wearables and smart-home hardware',
    covers: ['Tech'],
    voice: {
      rhythm:
        'Short and declarative. Most sentences under 15 words, with an occasional long one that carries a full spec. Opens sections with the number, not the wind-up.',
      vocabulary:
        'Names chipsets, codecs, standards and model numbers on first mention. Uses the measured unit every time (AW, dB, nits, mAh). Never writes "powerful", "fast" or "premium" without the figure beside it.',
      cares:
        'Whether a spec claim survives contact with a measurement, and which of two near-identical models is the one actually on sale here.',
      specimen:
        'The XM6 runs the QN3 processor and LDAC. Sony rates it at 30 hours with ANC on; RTINGS measured 28.5 in 2026, which is close enough to trust. The XM5 is the same headphone minus the new processor, and it is regularly A$120 less. If you are not listening on a hi-res source, the older one is the better buy and nothing about the spec sheet argues otherwise.',
    },
  },
  {
    id: 'home-desk',
    name: 'SleekDrops Home Desk',
    beat: 'Kitchen, cleaning, furniture and everything that has to survive daily use',
    covers: ['Home', 'Fashion'],
    voice: {
      rhythm:
        'Longer, plainer sentences that run 18-28 words, cut by a blunt five-word judgement. Reads like someone talking across a kitchen bench.',
      vocabulary:
        'Domestic and physical: what it weighs, what it sounds like at 7am, what the filter costs to replace. Avoids trade jargon; explains a spec in what it does rather than what it is.',
      cares:
        'What the thing is like to live with after six months - the seals, the filters, the bit that always goes first.',
      specimen:
        'Air fryers are mostly the same box with a different fan, and the part that decides whether you keep using one is the basket coating. Owners report it flaking on the cheaper Kmart units inside a year, on 61 of 890 ProductReview entries. The Ninja costs more and its basket is heavier to lift out one-handed, which matters if you are draining hot oil over a sink. That trade is the whole decision.',
    },
  },
  {
    id: 'value-desk',
    name: 'SleekDrops Value Desk',
    beat: 'Price, warranty, running costs and the money side of Health, Finance and Travel buys',
    covers: ['Finance', 'Travel', 'Health'],
    voice: {
      rhythm:
        'Arithmetic in the prose. Sentences build to a figure and stop there. Frequent two-sentence paragraphs, the second one the sum.',
      vocabulary:
        'Money words used precisely: RRP, street price, cost per year, excess, warranty term. Never "affordable", "budget-friendly" or "great value" - a dollar figure instead.',
      cares:
        'What the thing costs over its life rather than at the till, and what the warranty actually covers when it fails.',
      specimen:
        'The RRP is A$399 and Philips warrants it for two years. Replacement heads are A$45 for a pack of four and the manual says to change them quarterly, so budget A$45 a year on top. Over the warranty term that is A$489 all in. The A$199 model takes the same heads, which makes the gap A$200 for a pressure sensor and a travel case.',
    },
  },
];

/** The desk with this id, or null. Ids come out of a model, so nothing is assumed. */
export function authorById(id: unknown): AuthorProfile | null {
  return AUTHORS.find((a) => a.id === id) ?? null;
}

/**
 * The desk that owns a category, deterministically. This is the fallback when
 * the angle stage names a byline that does not exist - a beat match beats
 * defaulting everything to the generalist desk, which is how every piece ended
 * up in one voice in the first place.
 */
export function defaultAuthorFor(category: string): AuthorProfile {
  const match = AUTHORS.find((a) => a.covers.includes(category));
  return match ?? AUTHORS.find((a) => a.covers.length === 0) ?? AUTHORS[0];
}

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
