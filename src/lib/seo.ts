import type {
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
import type { Author, BreadcrumbItem, Deal, MetaPayload, Post, Product, Promo } from '../types';

const siteUrl = (import.meta.env.SITE_URL ?? 'https://sleekdrops.com').replace(/\/$/, '');
const defaultImage = `${siteUrl}/og-default.png`;

function normalizeDescription(description: string): string {
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
    description: normalizeDescription(input.description),
    canonicalUrl: absoluteUrl(input.pathname),
    image: input.image ? absoluteUrl(input.image) : defaultImage,
    type: input.type ?? 'website',
    noindex: input.noindex,
    prevUrl: input.prevUrl,
    nextUrl: input.nextUrl,
  };
}

export function buildBreadcrumbSchema(items: BreadcrumbItem[]): WithContext<BreadcrumbList> {
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
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteUrl}/blog?query={search_term_string}`,
      'query-input': 'required name=search_term_string',
    } as never,
    publisher: {
      '@type': 'Organization',
      name: 'SleekDrops',
      url: siteUrl,
      logo: defaultImage,
    } as Organization,
  };
}

export function buildArticleSchema(post: Post): WithContext<Thing> {
  return {
    '@context': 'https://schema.org',
    '@type': post.schemaType,
    headline: post.seoTitle ?? post.title,
    description: post.seoDescription ?? post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt ?? post.publishedAt,
    author: { '@type': 'Person', name: post.author },
    articleSection: post.category,
    keywords: post.tags.join(', '),
    image: post.featuredImage ? [absoluteUrl(post.featuredImage)] : [defaultImage],
    mainEntityOfPage: absoluteUrl(post.postType === 'review' ? `/reviews/${post.slug}` : `/blog/${post.slug}`),
    publisher: {
      '@type': 'Organization',
      name: 'SleekDrops',
      url: siteUrl,
      logo: defaultImage,
    } as Organization,
  };
}

export const buildPostSchema = buildArticleSchema;

export function buildReviewSchema(post: Post, product?: Product | null): WithContext<Thing> {
  if (!product) return buildArticleSchema(post);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Product',
        name: product.name,
        description: product.description,
        image: product.imageUrl ? absoluteUrl(product.imageUrl) : defaultImage,
        brand: product.brand,
        offers: {
          '@type': 'Offer',
          priceCurrency: product.currency,
          price: product.salePrice ?? product.originalPrice ?? 0,
          availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          url: product.affiliateUrl,
        },
        aggregateRating: product.rating
          ? {
              '@type': 'AggregateRating',
              ratingValue: product.rating,
              reviewCount: 1,
            }
          : undefined,
      } as ProductSchema,
      {
        '@type': 'Review',
        name: post.title,
        reviewBody: post.description,
        author: { '@type': 'Person', name: post.author },
        itemReviewed: { '@type': 'Product', name: product.name },
        reviewRating: product.rating
          ? {
              '@type': 'Rating',
              ratingValue: product.rating,
              bestRating: 5,
              worstRating: 1,
            }
          : undefined,
      } as Review,
    ],
  } as unknown as WithContext<Thing>;
}

export function buildOfferSchema(item: Deal | Promo, pathname: string, title: string): WithContext<Offer> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Offer',
    name: title,
    description: item.description,
    url: absoluteUrl(pathname),
    availability: item.isActive ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
    validThrough: item.expiresAt,
  };
}

export function buildCategorySchema(name: string, pathname: string, description: string): WithContext<CollectionPage> {
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
    mainEntity: {
      '@type': 'Person',
      name: author.name,
      description: author.bio,
      image: author.avatarUrl,
      sameAs: author.twitterUrl ? [author.twitterUrl] : [],
      jobTitle: author.role,
    } as Person,
    url: absoluteUrl(`/author/${author.slug}`),
  };
}
