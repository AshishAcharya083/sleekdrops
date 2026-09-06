/**
 * SEO helpers — meta payload construction, absolute URL resolution, and
 * JSON-LD schema builders for each page type. Imported by SEOHead and
 * the page front-matter.
 */

import type {
  Article,
  BreadcrumbList,
  CollectionPage,
  FAQPage,
  Offer,
  Organization,
  Person,
  Product as ProductSchema,
  ProfilePage,
  Review,
  Thing,
  WebSite,
  WithContext,
} from 'schema-dts';
import type { Author } from '@data/authors';
import type { Deal } from '@data/deals';
import type { Promo } from '@data/promos';
import type { BlogPost } from './posts';

// Same defensive read as ads-env / analytics-env / flags-env: Vite inlines
// `import.meta.env` at build time and the bare `node --test` runner has no such
// object, so reading a property off it directly makes the whole module
// unimportable from a test. The FAQ helpers at the bottom of this file are
// covered by one.
const siteUrl = (
  (import.meta.env as ImportMetaEnv | undefined)?.SITE_URL ?? 'https://sleekdrops.com'
).replace(/\/$/, '');

const defaultImage = `${siteUrl}/og-default.png`;

/** Every page is written for Australian readers; the schema says so. */
const LANGUAGE = 'en-AU';

const PUBLISHER: Organization = {
  '@type': 'Organization',
  name: 'SleekDrops',
  url: siteUrl,
  // The square mark, not the 1200x630 social card: Google's Article guidance
  // wants `publisher.logo` to be a logo, and reads it as an ImageObject.
  logo: { '@type': 'ImageObject', url: `${siteUrl}/mark.svg` },
};

/** The byline as structured data, pointing at the author's own page on this site. */
function personSchema(author: Author): Person {
  return { '@type': 'Person', name: author.name, url: absoluteUrl(`/author/${author.id}`) };
}

export interface BreadcrumbItem {
  name: string;
  href: string;
}

export interface MetaPayload {
  title: string;
  description: string;
  canonicalUrl: string;
  image: string;
  type: 'website' | 'article';
  noindex?: boolean;
  prevUrl?: string;
  nextUrl?: string;
}

function clampDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 160) return collapsed;
  return `${collapsed.slice(0, 157).trimEnd()}...`;
}

export function absoluteUrl(pathname: string): string {
  if (/^https?:\/\//.test(pathname)) return pathname;
  return `${siteUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export function buildMeta(input: {
  title: string;
  description: string;
  pathname: string;
  image?: string;
  type?: 'website' | 'article';
  noindex?: boolean;
  prevUrl?: string;
  nextUrl?: string;
}): MetaPayload {
  return {
    title: input.title,
    description: clampDescription(input.description),
    canonicalUrl: absoluteUrl(input.pathname),
    image: input.image ? absoluteUrl(input.image) : defaultImage,
    type: input.type ?? 'website',
    noindex: input.noindex,
    prevUrl: input.prevUrl,
    nextUrl: input.nextUrl,
  };
}

export function buildBreadcrumbSchema(
  items: BreadcrumbItem[],
): WithContext<BreadcrumbList> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.href),
    })),
  };
}

export function buildHomeSchema(): WithContext<WebSite> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'SleekDrops',
    url: siteUrl,
    publisher: PUBLISHER,
  };
}

export function buildArticleSchema(
  post: BlogPost,
  author: Author,
): WithContext<Article> {
  const url = absoluteUrl(`/blog/${post.slug}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.data.title,
    description: post.data.dek,
    url,
    inLanguage: LANGUAGE,
    datePublished: post.data.pubDate.toISOString(),
    dateModified: (post.data.updatedDate ?? post.data.pubDate).toISOString(),
    author: personSchema(author),
    articleSection: post.data.category,
    keywords: post.data.tags.join(', '),
    image: [post.data.heroImage ?? defaultImage],
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    publisher: PUBLISHER,
  };
}

/**
 * Build Product + Review JSON-LD from a review post's embedded product data.
 *
 * Pre-condition: post.data.postType === 'review' AND post.data.product is set.
 * Enforced by the content-collection refine() in src/content/config.ts.
 *
 * The Offer URL points to /go/<post.slug>; the redirect target lives in
 * the sleekdrops-cms repo's data/affiliate-links.json keyed by the same slug.
 */
export function buildReviewSchema(
  post: BlogPost,
  author: Author,
): WithContext<Thing> {
  const product = post.data.product;
  if (!product) {
    // Should never happen — the content schema enforces this. Throw loudly so
    // we catch any drift between schema and runtime.
    throw new Error(
      `buildReviewSchema called on post "${post.slug}" but post.data.product is undefined. ` +
        'Set postType: review and add a product object in frontmatter, or call buildArticleSchema instead.',
    );
  }

  const reviewedProduct: ProductSchema = {
    '@type': 'Product',
    name: product.name,
    brand: { '@type': 'Brand', name: product.brand },
    description: product.tagline,
    offers: {
      '@type': 'Offer',
      // The audience and the frontmatter price are Australian.
      priceCurrency: 'AUD',
      price: product.price.replace(/[^0-9.]/g, ''),
      availability: 'https://schema.org/InStock',
      url: absoluteUrl(`/go/${post.slug}`),
    },
    // No AggregateRating: schema.org defines it as "the average rating based on
    // multiple ratings or reviews", and one editorial review is not that. The
    // single Review below is the honest shape and is enough for a product snippet.
  };

  const review: Review = {
    '@type': 'Review',
    name: post.data.title,
    reviewBody: post.data.dek,
    author: personSchema(author),
    itemReviewed: reviewedProduct,
    reviewRating: {
      '@type': 'Rating',
      ratingValue: product.rating,
      bestRating: 5,
      worstRating: 1,
    },
    publisher: PUBLISHER,
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [reviewedProduct, review],
  } as unknown as WithContext<Thing>;
}

export function buildOfferSchema(
  item: Deal | Promo,
  pathname: string,
  title: string,
): WithContext<Offer> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Offer',
    name: title,
    description: item.description,
    url: absoluteUrl(pathname),
    availability:
      new Date(item.expiresAt).getTime() >= Date.now()
        ? 'https://schema.org/InStock'
        : 'https://schema.org/SoldOut',
    validThrough: item.expiresAt,
  };
}

export function buildCategorySchema(
  name: string,
  pathname: string,
  description: string,
): WithContext<CollectionPage> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    url: absoluteUrl(pathname),
    description,
  };
}

export function buildAuthorSchema(author: Author): WithContext<ProfilePage> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: author.name,
    url: absoluteUrl(`/author/${author.id}`),
    mainEntity: {
      '@type': 'Person',
      name: author.name,
      description: author.bio,
      jobTitle: author.role,
      sameAs: author.url ? [author.url] : [],
    } as Person,
  };
}

// ---------------------------------------------------------------------------
// FAQ structured data
//
// Generative engines (AI Overviews, ChatGPT, Perplexity) cite pages that hand
// them a clean question/answer pair far more often than pages that bury the
// same answer in prose. That is what the visible "## FAQ" section every
// pipeline article ends with is for. The FAQPage markup derived from it here is
// valid schema.org and harmless, but it is no longer a Google lever: Google
// stopped showing FAQ rich results on 7 May 2026 and removed the feature's
// documentation in June, and its AI guidance says no special markup is needed
// for AI Overviews or AI Mode. Keep the section; do not expect the markup to
// do the work. The schema is derived from the body rather than carried as
// another frontmatter field nobody would keep in sync.
// ---------------------------------------------------------------------------

export interface FaqEntry {
  question: string;
  answer: string;
}

/** Answers longer than this are truncated at a sentence boundary. */
const MAX_ANSWER_CHARS = 500;

/** Strip the markdown an answer may carry so the schema holds plain text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Keep the anchor text of a link, drop the target.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampAnswer(text: string): string {
  if (text.length <= MAX_ANSWER_CHARS) return text;
  const cut = text.slice(0, MAX_ANSWER_CHARS);
  const lastStop = cut.lastIndexOf('. ');
  return lastStop > MAX_ANSWER_CHARS / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}...`;
}

/**
 * Pull the Q&A pairs out of an article's markdown body.
 *
 * Looks for an H2 whose text starts with "FAQ" (or "Frequently asked..."),
 * then takes each H3 under it as a question and the prose that follows as its
 * answer, up to the next heading. Returns an empty array when the article has
 * no FAQ section, which is the common case for the older hand-written posts.
 */
export function extractFaq(body: string): FaqEntry[] {
  const lines = (body ?? '').split('\n');
  const entries: FaqEntry[] = [];

  let inFaq = false;
  let inFence = false;
  let question: string | null = null;
  let answer: string[] = [];

  const flush = (): void => {
    if (!question) return;
    const text = clampAnswer(plainText(answer.join('\n')));
    // A heading with nothing under it is not an answer, and Google rejects
    // FAQPage entries with an empty acceptedAnswer.
    if (text.length > 0) entries.push({ question, answer: text });
    question = null;
    answer = [];
  };

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (inFaq && question) answer.push(line);
      continue;
    }
    if (inFence) {
      if (inFaq && question) answer.push(line);
      continue;
    }

    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flush();
      inFaq = /^(?:faqs?\b|frequently\s+asked)/i.test(h2[1].trim());
      continue;
    }
    if (!inFaq) continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flush();
      question = plainText(h3[1]);
      continue;
    }
    // An H4+ inside an answer stays part of the answer text.
    if (question) answer.push(line.replace(/^#{4,}\s+/, ''));
  }
  flush();

  return entries;
}

/**
 * FAQPage JSON-LD. Returns null below two entries: a one-question FAQPage is
 * not eligible for the rich result and is not worth the markup.
 */
export function buildFaqSchema(entries: FaqEntry[]): WithContext<FAQPage> | null {
  if (entries.length < 2) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answer },
    })),
  };
}
