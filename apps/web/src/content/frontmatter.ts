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
 * it is `unknown`: a source whose publisher the researcher could not confirm is
 * shown as such rather than quietly promoted.
 *
 * `publisher` is optional only so posts already in D1 keep validating; the
 * assembler always writes one, falling back to the source's hostname.
 */
const SOURCE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * Whether a string is a URL a reader could safely be linked to.
 *
 * `z.string().url()` is not this check: it accepts `javascript:` and `data:`,
 * so a schema that only calls it hands a click-to-execute href to whatever
 * renders the field. Every source, claim and launch URL below is rendered as
 * an `href` by an article component, and all of them originate in
 * search-result text nobody controls - so the scheme is checked here rather
 * than assumed. Mirrors `isWebUrl` in the agent's content/contract.ts.
 */
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const webUrl = () => z.string().url().refine(isWebUrl, { message: 'must be an http(s) URL' });

export const sourceSchema = z.object({
  url: webUrl(),
  publisher: z.string().min(1).optional(),
  date: z.string().regex(SOURCE_DATE).optional(),
  tier: z.enum(sourceTiers).optional(),
  // What this source measured, when it measured something. A protocol is what
  // makes a figure checkable, so it travels with the figure. All optional and
  // purely additive: a post assembled before the researcher recorded
  // measurements carries none of them and renders exactly as it did.
  /** What was measured: "Peak brightness", "Battery life, screen-on". */
  metric: z.string().min(1).optional(),
  /** The figure, as this source published it. */
  measured: z.string().min(1).optional(),
  /** The conditions behind the figure, in the tester's words. */
  conditions: z.string().min(1).optional(),
  /** A figure this source has since corrected away from, shown struck beside the current one. */
  withdrawn: z.string().min(1).optional(),
});

export type SourceData = z.infer<typeof sourceSchema>;

/**
 * What a figure on the page is, by where its number came from.
 *
 * Mirrors `CLAIM_TIERS` in the agent's content/claims.ts, where the tier is
 * derived from who produced the number rather than declared by whoever wrote
 * the sentence. 'context' is not a claim about the product at all: a brand
 * satisfaction survey says something about a brand, and is shown beside the
 * measurements rather than as one of them.
 */
export const claimTiers = ['measured', 'independent', 'manufacturer', 'context'] as const;

export type ClaimTier = (typeof claimTiers)[number];

/**
 * One headline figure and its provenance - the record behind the label the
 * page prints beside every number it states.
 *
 * `claimed` is the maker's figure for the same metric, kept beside a measured
 * one rather than replaced by it. Readers arrive having already seen the box
 * claim; dropping it reads as a page that missed the spec, and the gap between
 * the two is usually the most useful thing on it. What is never allowed is the
 * other direction - a maker's number restated in our own voice as though we
 * had checked it.
 */
export const claimSchema = z.object({
  /** The product this figure describes, named as the page names it. */
  subject: z.string().min(1),
  /** The /go/ slug of the pick it is about, when it is about a pick. */
  goSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  /** What was measured: "Battery life, screen-on". */
  metric: z.string().min(1),
  tier: z.enum(claimTiers),
  /** The figure this tier leads with, as its source published it. */
  value: z.string().min(1),
  /** Who produced the figure. Never optional - an unattributed number is the fault. */
  attribution: z.string().min(1),
  /** The protocol or conditions the figure was produced under. */
  conditions: z.string().min(1).optional(),
  date: z.string().regex(SOURCE_DATE).optional(),
  sourceUrl: webUrl().optional(),
  /** What the source's result actually covers - load-bearing for brand-level raters. */
  covers: z.string().min(1).optional(),
  /** A figure this source has since corrected away from. */
  withdrawn: z.string().min(1).optional(),
  claimed: z
    .object({
      value: z.string().min(1),
      by: z.string().min(1),
      conditions: z.string().min(1).optional(),
      sourceUrl: webUrl().optional(),
    })
    .optional(),
});

export type ClaimData = z.infer<typeof claimSchema>;

/**
 * The release a piece was written against, set only when it was written inside
 * a product's launch window.
 *
 * The page works out from this date whether the window is still open rather
 * than being told: a stored "no lab has tested this yet" would still say so
 * six months later, which is the stale disclosure this replaces.
 */
export const launchSchema = z.object({
  product: z.string().min(1),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUrl: webUrl().optional(),
});

export type LaunchData = z.infer<typeof launchSchema>;

/**
 * How the unit under review was obtained.
 *
 * The ACCC's reviews sweep found this disclosure missing more often than any
 * other, and its standard is about placement as much as wording: a benefit
 * received in connection with a review has to be disclosed with the content
 * itself, not on a policy page. 'none' is a real state and the site's usual
 * one - "we were not sent a unit" is the thing a reader of a
 * no-sponsored-posts site is owed, and silence is what reads as concealment.
 */
export const reviewUnitSchema = z.object({
  acquisition: z.enum(['retail', 'loan', 'none']),
  /** The brand or agency that lent it - named, because "supplied for review" names nobody. */
  supplier: z.string().min(1).optional(),
  paid: z.string().min(1).optional(),
  /** Month and year it went back. Month precision: verifiable, and cheap to keep true. */
  returned: z.string().regex(SOURCE_DATE).optional(),
});

export type ReviewUnitData = z.infer<typeof reviewUnitSchema>;

/**
 * The offer behind a pick: a price somebody saw on a stated day, not a price
 * anything is polling.
 *
 * A product announced this week carries no affiliate-feed row and cannot be
 * read through Amazon's Product Advertising API, so a figure on the page is
 * whatever a person (or a feed that has since gone quiet) last saw. `asAt` is
 * therefore not decoration: with it the page quotes an RRP, without it the
 * page misstates a live price. Mirrors `pickOfferSchema` in the agent's
 * content/contract.ts.
 */
export const pickOfferSchema = z.object({
  /** Formatted for the reader, e.g. "A$2,899". */
  price: z.string().min(1),
  currency: z.string().min(1),
  /** The day the price was observed. */
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(['editor', 'feed', 'api']),
  /** True when the price must render as a dated RRP rather than as live. */
  stale: z.boolean(),
  merchant: z.string().min(1).optional(),
  preorder: z.boolean().optional(),
  /** When a pre-order ships — and therefore when the reader is charged. */
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type PickOfferData = z.infer<typeof pickOfferSchema>;

/**
 * A product the article recommends — one per /go/ slug the body links, with a
 * matching affiliate_links row behind it. Guides and roundups turn these into
 * an ItemList of Product nodes.
 */
export const pickSchema = z.object({
  name: z.string().min(1),
  brand: z.string().min(1).optional(),
  /**
   * As the research stated it, e.g. "A$229", or the attached offer's price
   * when one exists. The digits are parsed out into the pick's `offers.price`
   * (see src/lib/seo.ts); a pick with no parseable figure ships no Offer.
   */
  price: z.string().min(1).optional(),
  goSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** "Best overall", "Best value" - an editorial award, never resting on a maker's figure alone. */
  badge: z.string().min(1).optional(),
  /**
   * The standing evidence chip. Always filled where the pipeline wrote it, so
   * the pick without an award differs from the others in what its chip says
   * rather than in having none - an empty slot beside a filled one reads as a
   * defect in the product instead of a fact about our evidence.
   */
  evidence: z.enum(['tested', 'researched']).optional(),
  /** The attached offer, when the product carries one. */
  offer: pickOfferSchema.optional(),
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
    /**
     * One sentence on what changed at `updatedDate`, written by the pipeline
     * when a requalification actually moved something. Optional: a page whose
     * update was cosmetic carries no fresh date, and so carries no note.
     */
    updateNote: z.string().min(1).max(300).optional(),
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
    /** The tier-labelled figures the page prints beside its numbers. */
    claims: z.array(claimSchema).optional(),
    /** Set only on a piece written inside a product's launch window. */
    launch: launchSchema.optional(),
    /** How we got the unit under review, including when there was none. */
    reviewUnit: reviewUnitSchema.optional(),
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
