/**
 * SEO helpers — meta payload construction, absolute URL resolution, and
 * JSON-LD schema builders for each page type. Imported by SEOHead and
 * the page front-matter.
 */

import type {
  Article,
  BreadcrumbList,
  CollectionPage,
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

const siteUrl = (
  import.meta.env.SITE_URL ?? 'https://sleekdrops.com'
).replace(/\/$/, '');

const defaultImage = `${siteUrl}/og-default.png`;

const PUBLISHER: Organization = {
  '@type': 'Organization',
  name: 'SleekDrops',
  url: siteUrl,
  logo: defaultImage,
};

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
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteUrl}/blog?query={search_term_string}`,
      'query-input': 'required name=search_term_string',
    } as never,
  };
}

export function buildArticleSchema(
  post: BlogPost,
  author: Author,
): WithContext<Article> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.data.title,
    description: post.data.dek,
    datePublished: post.data.pubDate.toISOString(),
    dateModified: (post.data.updatedDate ?? post.data.pubDate).toISOString(),
    author: { '@type': 'Person', name: author.name },
    articleSection: post.data.category,
    keywords: post.data.tags.join(', '),
    image: [post.data.heroImage ?? defaultImage],
    mainEntityOfPage: absoluteUrl(`/blog/${post.slug}`),
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
      priceCurrency: 'USD',
      price: product.price.replace(/[^0-9.]/g, ''),
      availability: 'https://schema.org/InStock',
      url: absoluteUrl(`/go/${post.slug}`),
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: product.rating,
      reviewCount: 1,
      bestRating: 5,
      worstRating: 1,
    },
  };

  const review: Review = {
    '@type': 'Review',
    name: post.data.title,
    reviewBody: post.data.dek,
    author: { '@type': 'Person', name: author.name },
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
