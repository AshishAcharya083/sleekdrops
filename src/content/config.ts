import { defineCollection, z } from 'astro:content';

/**
 * Blog collection.
 *
 * The actual `.md` files are NOT committed to this repo. They live in the
 * sleekdrops-cms repository and are fetched into src/content/blog/ at build
 * time by scripts/fetch-content.mjs (see package.json -> scripts.dev/prebuild).
 *
 * This schema must stay in lockstep with sleekdrops-cms/scripts/validate.ts.
 * If a field changes here, change it there too.
 */

/**
 * Embedded product data for `postType: review` posts.
 * Replaces the old src/data/products.ts module — review structured data now
 * lives in the post's frontmatter, fully self-contained.
 *
 * The matching affiliate destination lives in (sleekdrops-cms) data/affiliate-links.json
 * under the same slug as the post filename. The Verdict / ProductCallout
 * components build the CTA href as `/go/${post.slug}`.
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

const blog = defineCollection({
  type: 'content',
  schema: z
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
      featured: z.boolean().default(false),
      draft: z.boolean().default(false),
    })
    .refine(
      (data) => data.postType !== 'review' || data.product !== undefined,
      { message: "postType: 'review' requires a `product` object in frontmatter" },
    ),
});

export const collections = { blog };
