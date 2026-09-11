/**
 * The blog collection's frontmatter contract, as plain Zod.
 *
 * It lives beside `config.ts` rather than inside it so it can be imported (and
 * tested) without pulling in the `astro:content` virtual module, which only
 * exists inside an Astro build. `astro/zod` is the same Zod instance
 * `astro:content` re-exports, so the schema behaves identically either way.
 *
 * This is the mirror of `frontmatterSchema` in the agent's
 * apps/agent/src/content/contract.ts, which is what validates a post before it
 * is ever written to D1. If a field changes here, change it there too — the
 * old sleekdrops-cms `validate.ts` counterpart was decommissioned 2026-06-13.
 */

import { z } from 'astro/zod';

/**
 * Embedded product data for `postType: review` posts.
 * Replaces the old src/data/products.ts module — review structured data now
 * lives in the post's frontmatter, fully self-contained.
 *
 * The matching affiliate destination is the D1 `affiliate_links` row carrying
 * the same slug as the post. The Verdict / ProductCallout components build the
 * CTA href as `/go/${post.slug}`.
 */
export const productSchema = z.object({
  /** Full product name including version/year. */
  name: z.string().min(1),
  /** Manufacturer. */
  brand: z.string().min(1),
  /** Single character for the logo tile. */
  brandMark: z.string().length(1),
  /** One-sentence verdict used in the Quick Verdict box + JSON-LD description. */
  tagline: z.string().min(1),
  /** Honest decimal 1.0–5.0. */
  rating: z.number().min(1).max(5),
  /** Merchant the CTA points to. */
  retailer: z.string().min(1),
  /** Pre-formatted current price, e.g. "$449". */
  price: z.string().min(1),
  /** Pre-formatted previous price for a sale badge. */
  priceWas: z.string().optional(),
  /** Optional CTA badge ("Editor's choice", "Best value"). */
  badge: z.string().optional(),
  /** 3–5 genuine pros. */
  pros: z.array(z.string().min(1)).min(3).max(5),
  /** 2–4 honest cons. The cons column is never empty. */
  cons: z.array(z.string().min(1)).min(2).max(4),
  /** Optional key→value spec table. */
  specs: z.record(z.string()).optional(),
});

export type ProductData = z.infer<typeof productSchema>;

/**
 * What kind of evidence a source is. Mirrors `SourceTier` in the agent's
 * pipeline/types.ts, the vocabulary the researcher files each fact under.
 */
export const sourceTiers = ['primary', 'expert', 'owner', 'aggregator', 'unknown'] as const;

export type SourceTier = (typeof sourceTiers)[number];

/**
 * A source behind the article, written by the agent's assembler from the
 * research dossier. It is rendered in the visible sources block at the foot of
 * the article and mirrored into JSON-LD `citation` in src/lib/seo.ts.
 *
 * `date` carries whatever precision the source itself publishes - a spec sheet
 * dated to the day, a lab result to the month, a standard to the year - because
 * padding a year out to a day would invent a fact. `tier` is carried even when
 * it is `unknown`: a source the researcher could not place is shown as unplaced
 * rather than quietly promoted.
 *
 * `publisher` is optional only so posts already in D1 keep validating; the
 * assembler always writes one, falling back to the source's hostname.
 */
export const sourceSchema = z.object({
  url: z.string().url(),
  publisher: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/).optional(),
  tier: z.enum(sourceTiers).optional(),
});

export type SourceData = z.infer<typeof sourceSchema>;

/**
 * A product the article recommends — one per /go/ slug the body links, with a
 * matching affiliate_links row behind it. Guides and roundups turn these into
 * an ItemList of Product nodes.
 */
export const pickSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1).optional(),
  /**
   * As the research stated it, e.g. "A$229". The digits are parsed out into
   * the pick's `offers.price` (see src/lib/seo.ts); a pick with no parseable
   * figure ships no Offer.
   */
  price: z.string().min(1).optional(),
  goSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export type PickData = z.infer<typeof pickSchema>;

/** Frontmatter every post in the blog collection must satisfy. */
export const blogFrontmatterSchema = z
  .object({
    title: z.string(),
    /** One-sentence subhead / dek / excerpt. */
    dek: z.string(),
    category: z.enum([
      'Tech',
      'Home',
      'Fashion',
      'Health',
      'Finance',
      'Travel',
    ]),
    /** Drives layout choice and JSON-LD schema. */
    postType: z
      .enum(['article', 'review', 'guide', 'roundup'])
      .default('article'),
    /** Human-facing badge label, e.g. "Buying guide", "Review", "Comparison". */
    kind: z.string().optional(),
    /** Author id — must match an entry in src/data/authors.ts. */
    author: z.string(),
    tags: z.array(z.string()).default([]),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    /**
     * When a human last reviewed the piece against its sources - a different
     * promise from when it was published or last edited, and shown as such.
     * Optional: every post published before the assembler stamped one has none.
     */
    lastReviewed: z.coerce.date().optional(),
    readTime: z.number().int().positive(),
    cover: z.enum([
      'fill-1',
      'fill-2',
      'fill-3',
      'fill-4',
      'fill-5',
      'fill-6',
      'fill-7',
      'fill-8',
    ]),
    /** Optional absolute hero image URL (Cloudflare R2). */
    heroImage: z.string().url().optional(),
    heroAlt: z.string().optional(),
    /** Embedded product object — required when postType === 'review'. */
    product: productSchema.optional(),
    // Structured-data inputs written by the pipeline's assembler. All
    // optional: posts published before they existed carry none of them.
    /** Sources the research drew on — JSON-LD `citation`. */
    sources: z.array(sourceSchema).optional(),
    /** Named things the piece covers — JSON-LD `about` / `mentions`. */
    entities: z.array(z.string().min(1)).optional(),
    /** Recommended products — the ItemList on guides and roundups. */
    picks: z.array(pickSchema).optional(),
    /** ISO 4217 code every price this post quotes is in. */
    currency: z.string().min(1).default('AUD'),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  })
  .refine(
    (data) => data.postType !== 'review' || data.product !== undefined,
    { message: "postType: 'review' requires a `product` object in frontmatter" },
  );

export type BlogFrontmatter = z.infer<typeof blogFrontmatterSchema>;
