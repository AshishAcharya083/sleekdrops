/**
 * SEO helpers — meta payload construction, absolute URL resolution, and
 * JSON-LD schema builders for each page type. Imported by SEOHead and
 * the page front-matter.
 *
 * Post pages ship one linked `@graph` rather than a stack of loose objects:
 * the publisher, the site, the page, the byline and the article are separate
 * nodes with stable `@id`s that reference each other, which is the shape a
 * generative engine can actually resolve into a knowledge graph.
 */

import type {
  Article,
  BreadcrumbList,
  CollectionPage,
  FAQPage,
  ItemList,
  Offer,
  Organization,
  Person,
  Product as ProductSchema,
  ProfilePage,
  Review,
  Thing,
  WebPage,
  WebSite,
  WithContext,
} from 'schema-dts';
import type { Author } from '@data/authors';
import type { Deal } from '@data/deals';
import type { Promo } from '@data/promos';
import type { PickData, SourceData } from '../content/frontmatter';
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

/** The audience, and every price on the site, is Australian. */
const DEFAULT_CURRENCY = 'AUD';

// Stable node identities. They are fragments of the site's own URLs so the
// same organisation, site and person mean the same node on every page that
// declares them.
const ORGANIZATION_ID = `${siteUrl}/#organization`;
const WEBSITE_ID = `${siteUrl}/#website`;

/**
 * External profiles the publisher actually controls. `sameAs` is an identity
 * claim, so it stays empty until there is a real profile to point at rather
 * than naming something we do not own.
 */
const PUBLISHER_PROFILES: string[] = [];

const PUBLISHER: Organization = {
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: 'SleekDrops',
  url: siteUrl,
  // The square mark, not the 1200x630 social card: Google's Article guidance
  // wants `publisher.logo` to be a logo, and reads it as an ImageObject.
  logo: { '@type': 'ImageObject', url: `${siteUrl}/mark.svg` },
  publishingPrinciples: `${siteUrl}/about`,
  ...(PUBLISHER_PROFILES.length > 0 ? { sameAs: PUBLISHER_PROFILES } : {}),
};

const WEBSITE: WebSite = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: 'SleekDrops',
  url: siteUrl,
  inLanguage: LANGUAGE,
  publisher: { '@id': ORGANIZATION_ID },
};

function authorPageUrl(author: Author): string {
  return absoluteUrl(`/author/${author.id}`);
}

function authorId(author: Author): string {
  return `${authorPageUrl(author)}#person`;
}

/** Words that name a job, not a subject — they do not belong in `knowsAbout`. */
const JOB_TITLE_WORD = /\b(editor|writer|reporter|contributor|journalist)\b/i;

/**
 * The subjects a byline covers: their beat, split where it names more than one
 * ("Audio & tech"), plus the section this piece sits in. Deduped case-
 * insensitively so "tech" and "Tech" are one topic.
 */
function authorTopics(author: Author, category?: string): string[] {
  const topics = new Map<string, string>();
  for (const part of [...author.role.split(/\s*[&,/]\s*/), category ?? '']) {
    const topic = part.trim();
    if (!topic || JOB_TITLE_WORD.test(topic)) continue;
    const key = topic.toLowerCase();
    if (!topics.has(key)) topics.set(key, `${topic[0].toUpperCase()}${topic.slice(1)}`);
  }
  return [...topics.values()];
}

/** The byline as a graph node: same `@id` here, on the author page and in a Review. */
function authorNode(author: Author, category?: string): Person {
  const topics = authorTopics(author, category);
  return {
    '@type': 'Person',
    '@id': authorId(author),
    name: author.name,
    url: authorPageUrl(author),
    description: author.bio,
    jobTitle: author.role,
    ...(topics.length > 0 ? { knowsAbout: topics } : {}),
    ...(author.url ? { sameAs: [author.url] } : {}),
  };
}

/** Site-wide identity for a named entity, so the same thing is one node everywhere. */
function entityNode(name: string): Thing {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    '@type': 'Thing',
    ...(slug ? { '@id': `${siteUrl}/#/entity/${slug}` } : {}),
    name,
  };
}

/** How many of the keyword plan's entities the piece is `about`; the rest it `mentions`. */
const ABOUT_ENTITY_COUNT = 3;

function citationNode(source: SourceData): WebPage {
  return {
    '@type': 'WebPage',
    '@id': source.url,
    url: source.url,
    ...(source.publisher
      ? { publisher: { '@type': 'Organization', name: source.publisher } }
      : {}),
    ...(source.date ? { datePublished: source.date } : {}),
  };
}

/**
 * The number out of a price as it was stated ("A$2,699", "around $180"). Null
 * when there is no number in it — an offer with an invented price is worse
 * than no offer at all.
 *
 * A currency symbol wins over any other number in the string, so "2026 model,
 * $199" prices the model at 199 rather than at the year.
 *
 * Only ever applied to a price the page itself displays; see `productNode`.
 */
function parsePrice(stated: string | undefined): string | null {
  const cleaned = stated?.replace(/,/g, '');
  if (!cleaned) return null;
  const tagged = cleaned.match(/(?:AUD|A?\$)\s*(\d+(?:\.\d{1,2})?)/i);
  if (tagged) return tagged[1];
  const bare = cleaned.match(/\d+(?:\.\d{1,2})?/);
  return bare ? bare[0] : null;
}

/** Body words, markdown stripped — Article.wordCount. */
function countWords(body: string): number {
  const text = plainText((body ?? '').replace(/^#{1,6}\s+/gm, ''));
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function graph(nodes: Thing[]): WithContext<Thing> {
  return { '@context': 'https://schema.org', '@graph': nodes } as unknown as WithContext<Thing>;
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

/** The home page is where the site and its publisher are declared in full. */
export function buildHomeSchema(): WithContext<Thing> {
  return graph([PUBLISHER, WEBSITE]);
}

function postUrl(post: BlogPost): string {
  return absoluteUrl(`/blog/${post.slug}`);
}

/**
 * Publisher, site, page, byline and article as one linked graph.
 *
 * `mainEntityId` is the node the piece is really about when there is one — the
 * ItemList of picks on a roundup, the Product on a review.
 */
function postNodes(post: BlogPost, author: Author, mainEntityId?: string): Thing[] {
  const url = postUrl(post);
  const webPageId = `${url}#webpage`;
  const entities = post.data.entities ?? [];
  const sources = post.data.sources ?? [];
  const words = countWords(post.body);
  const datePublished = post.data.pubDate.toISOString();
  // Distinct from datePublished whenever the post has been revised; a post
  // that never has says so honestly rather than claiming freshness.
  const dateModified = (post.data.updatedDate ?? post.data.pubDate).toISOString();
  const image = post.data.heroImage ?? defaultImage;
  const about = entities.slice(0, ABOUT_ENTITY_COUNT);
  const mentions = entities.slice(ABOUT_ENTITY_COUNT);

  const webPage: WebPage = {
    '@type': 'WebPage',
    '@id': webPageId,
    url,
    name: post.data.title,
    description: post.data.dek,
    inLanguage: LANGUAGE,
    isPartOf: { '@id': WEBSITE_ID },
    datePublished,
    dateModified,
    primaryImageOfPage: { '@type': 'ImageObject', url: image },
  };

  const article: Article = {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: post.data.title,
    description: post.data.dek,
    url,
    inLanguage: LANGUAGE,
    datePublished,
    dateModified,
    author: { '@id': authorId(author) },
    publisher: { '@id': ORGANIZATION_ID },
    isPartOf: { '@id': webPageId },
    mainEntityOfPage: { '@id': webPageId },
    articleSection: post.data.category,
    keywords: post.data.tags.join(', '),
    image: [image],
    ...(words > 0 ? { wordCount: words } : {}),
    ...(about.length > 0 ? { about: about.map(entityNode) } : {}),
    ...(mentions.length > 0 ? { mentions: mentions.map(entityNode) } : {}),
    ...(sources.length > 0 ? { citation: sources.map(citationNode) } : {}),
    ...(mainEntityId ? { mainEntity: { '@id': mainEntityId } } : {}),
  };

  return [PUBLISHER, WEBSITE, webPage, authorNode(author, post.data.category), article];
}

/** Post types whose whole point is a ranked set of products. */
const LIST_POST_TYPES = new Set(['guide', 'roundup']);

/**
 * One rendered heading, as `post.render()` hands them back: `slug` is the id
 * Astro actually emitted on the `<h*>`, so an anchor built from it resolves.
 */
export interface PostHeading {
  depth: number;
  slug: string;
  text: string;
}

const GO_LINK = /\/go\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

/**
 * The id of the section each pick is recommended in, keyed by its /go/ slug —
 * the ItemList entries point at those anchors, which is the shape Google
 * documents for a list whose items all live on one page.
 *
 * Headings are matched by position rather than by text: `headings` is in
 * document order, one entry per heading Astro rendered, so the nth `#` line in
 * the body is `headings[n]` whatever markdown that heading contains. If the
 * two ever disagree on how many headings there are (a setext heading, say),
 * no anchors are returned at all rather than a set that has drifted by one.
 */
function pickAnchors(body: string, headings: PostHeading[]): Map<string, string> {
  const anchors = new Map<string, string>();
  let seen = 0;
  let inFence = false;
  let section: string | null = null;

  for (const line of (body ?? '').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+/.test(line)) {
      section = headings[seen]?.slug ?? null;
      seen += 1;
      continue;
    }
    if (!section) continue;
    for (const [, slug] of line.matchAll(GO_LINK)) {
      if (!anchors.has(slug)) anchors.set(slug, section);
    }
  }

  return seen === headings.length ? anchors : new Map();
}

/**
 * A recommended pick as a Product node.
 *
 * Deliberately carries no `offers`. The research states an approximate or RRP
 * figure, the page never prints it, and Google's structured-data policies
 * require markup to describe content the reader can actually see — a price
 * that exists only in the markup is the pattern they suppress rich results
 * for, and an Amazon-derived figure baked into a static build would breach the
 * Associates 24-hour refresh rule besides. If a live, displayed price ever
 * lands on the page, an Offer mirroring it exactly is the change to make.
 *
 * No `aggregateRating` either: we earn commission on this product, so a rating
 * we award ourselves is the self-serving markup the same guidelines exclude.
 */
function productNode(pick: PickData, pageUrl: string): ProductSchema {
  return {
    '@type': 'Product',
    '@id': `${pageUrl}#pick-${pick.goSlug}`,
    name: pick.name,
    ...(pick.brand ? { brand: { '@type': 'Brand', name: pick.brand } } : {}),
  };
}

/**
 * The ranked picks of a guide or roundup as an ItemList of Product nodes.
 * Null when the post is not one of those, or carries no picks — every post
 * published before the pipeline wrote them is in that case.
 */
function buildPickList(
  post: BlogPost,
  headings: PostHeading[],
): { id: string; node: ItemList } | null {
  const picks = post.data.picks ?? [];
  if (picks.length === 0 || !LIST_POST_TYPES.has(post.data.postType)) return null;

  const url = postUrl(post);
  const anchors = pickAnchors(post.body, headings);
  return {
    id: `${url}#picks`,
    node: {
      '@type': 'ItemList',
      '@id': `${url}#picks`,
      name: post.data.title,
      numberOfItems: picks.length,
      // The body ranks them; position 1 is the top pick.
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: picks.map((pick, index) => {
        const anchor = anchors.get(pick.goSlug);
        return {
          '@type': 'ListItem',
          position: index + 1,
          ...(anchor ? { url: `${url}#${anchor}` } : {}),
          item: productNode(pick, url),
        };
      }),
    },
  };
}

/**
 * Article JSON-LD as a linked graph. Guides and roundups additionally carry
 * the ItemList of everything they recommend; a post with no picks, sources or
 * entities simply emits fewer nodes.
 *
 * `headings` are the ones `post.render()` returned, used to anchor each pick
 * to the section that recommends it. Omit them and the list still ships, just
 * without per-item URLs.
 */
export function buildArticleSchema(
  post: BlogPost,
  author: Author,
  headings: PostHeading[] = [],
): WithContext<Thing> {
  const picks = buildPickList(post, headings);
  return graph([...postNodes(post, author, picks?.id), ...(picks ? [picks.node] : [])]);
}

/**
 * The JSON-LD a blog post ships: the Product graph for a post with embedded
 * product data, the Article graph for everything else.
 */
export function buildPostSchema(
  post: BlogPost,
  author: Author,
  headings: PostHeading[] = [],
): WithContext<Thing> {
  return post.data.product
    ? buildReviewSchema(post, author)
    : buildArticleSchema(post, author, headings);
}

/**
 * Build Product + Review JSON-LD from a review post's embedded product data.
 *
 * Pre-condition: post.data.postType === 'review' AND post.data.product is set.
 * Enforced by the content-collection refine() in src/content/frontmatter.ts.
 *
 * The Offer URL points to /go/<post.slug>; the redirect target is the
 * affiliate_links row carrying the same slug.
 */
export function buildReviewSchema(post: BlogPost, author: Author): WithContext<Thing> {
  const product = post.data.product;
  if (!product) {
    // Should never happen — the content schema enforces this. Throw loudly so
    // we catch any drift between schema and runtime.
    throw new Error(
      `buildReviewSchema called on post "${post.slug}" but post.data.product is undefined. ` +
        'Set postType: review and add a product object in frontmatter, or call buildArticleSchema instead.',
    );
  }

  const url = postUrl(post);
  const productId = `${url}#product`;
  const reviewId = `${url}#review`;
  // The post says what it is priced in; AUD only as the fallback for a post
  // written before the field existed. Nothing here assumes a currency.
  const currency = post.data.currency ?? DEFAULT_CURRENCY;
  const price = parsePrice(product.price);

  const reviewedProduct: ProductSchema = {
    '@type': 'Product',
    '@id': productId,
    name: product.name,
    brand: { '@type': 'Brand', name: product.brand },
    description: product.tagline,
    review: { '@id': reviewId },
    // Unlike a guide's picks, this price is on the page — Verdict and
    // ProductCallout both print `product.price` — so mirroring it into an
    // Offer describes content the reader can see, which is what Google's
    // structured-data policies ask for.
    ...(price !== null
      ? {
          offers: {
            '@type': 'Offer',
            priceCurrency: currency,
            price,
            availability: 'https://schema.org/InStock',
            url: absoluteUrl(`/go/${post.slug}`),
          } satisfies Offer,
        }
      : {}),
    // No AggregateRating: schema.org defines it as "the average rating based on
    // multiple ratings or reviews", and one editorial review is not that — on a
    // product we earn commission on, awarding ourselves one is the self-serving
    // markup Google's guidelines exclude. The single Review below is the honest
    // shape and is enough for a product snippet.
  };

  const review: Review = {
    '@type': 'Review',
    '@id': reviewId,
    name: post.data.title,
    reviewBody: post.data.dek,
    author: { '@id': authorId(author) },
    itemReviewed: { '@id': productId },
    reviewRating: {
      '@type': 'Rating',
      ratingValue: product.rating,
      bestRating: 5,
      worstRating: 1,
    },
    publisher: { '@id': ORGANIZATION_ID },
  };

  return graph([...postNodes(post, author, productId), reviewedProduct, review]);
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
    url: authorPageUrl(author),
    // The same Person node every byline on the site points at.
    mainEntity: authorNode(author),
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
