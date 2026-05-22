import { z } from 'zod';
import { getReadingTime } from './reading-time';
import type { Author, Deal, PaginatedResponse, Post, Product, Promo } from '../types';

const BASE = import.meta.env.BLOG_API_URL ?? '';
const SITE = 'sleekdrops';

const postSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  content: z.string().default(''),
  postType: z.enum(['article', 'review', 'guide', 'roundup']).default('article'),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  author: z.string(),
  featuredImage: z.string().optional(),
  publishedAt: z.string(),
  updatedAt: z.string().optional(),
  readingTime: z.number().optional(),
  affiliateLinks: z.record(z.string(), z.string()).default({}),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  schemaType: z.enum(['Article', 'BlogPosting', 'FAQPage']).default('Article'),
  noindex: z.boolean().optional(),
});

const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  brand: z.string().optional(),
  description: z.string(),
  category: z.string(),
  affiliateUrl: z.string(),
  originalPrice: z.number().optional(),
  salePrice: z.number().optional(),
  currency: z.string(),
  rating: z.number().optional(),
  pros: z.array(z.string()).default([]),
  cons: z.array(z.string()).default([]),
  imageUrl: z.string().optional(),
  inStock: z.boolean().default(true),
});

const dealSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  slug: z.string(),
  promoCode: z.string().optional(),
  dealTitle: z.string(),
  description: z.string(),
  terms: z.string().optional(),
  affiliateUrl: z.string(),
  category: z.string(),
  originalPrice: z.number().optional(),
  dealPrice: z.number().optional(),
  discountPct: z.number().optional(),
  isActive: z.boolean(),
  expiresAt: z.string().optional(),
  logoUrl: z.string().optional(),
});

const promoSchema = z.object({
  id: z.string(),
  operatorName: z.string(),
  slug: z.string(),
  promoCode: z.string().optional(),
  promoTitle: z.string(),
  description: z.string(),
  terms: z.string().optional(),
  affiliateUrl: z.string(),
  category: z.string(),
  isActive: z.boolean(),
  expiresAt: z.string().optional(),
  rating: z.number().optional(),
  logoUrl: z.string().optional(),
});

const authorSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  bio: z.string().optional(),
  avatarUrl: z.string().optional(),
  twitterUrl: z.string().optional(),
  role: z.string(),
});

const paginatedPostSchema = z.object({
  data: z.array(postSchema),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});

function withReadingTime(post: Post): Post {
  return { ...post, readingTime: post.readingTime ?? getReadingTime(post.content) };
}

function getEmptyFallback(path: string): unknown {
  if (path.includes('/posts') || path.includes('/reviews') || path.includes('/authors/')) {
    return { data: [], total: 0, page: 1, totalPages: 1 };
  }
  return [];
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  if (!BASE) return schema.parse(getEmptyFallback(path));
  const url = new URL(path, BASE);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  });
  try {
    const response = await fetch(url, { headers: { 'x-site-id': SITE } });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return schema.parse(await response.json());
  } catch {
    return schema.parse(getEmptyFallback(path));
  }
}

export async function getPosts(params?: {
  category?: string;
  tag?: string;
  postType?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResponse<Post>> {
  const payload = await request('/posts', paginatedPostSchema, params);
  return { ...payload, data: payload.data.map((post) => withReadingTime(post)) };
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  const payload = await request(`/posts/${slug}`, postSchema.nullable());
  return payload ? withReadingTime(payload) : null;
}

export async function getReviews(params?: { category?: string; page?: number }): Promise<PaginatedResponse<Post>> {
  const payload = await request('/reviews', paginatedPostSchema, params);
  return { ...payload, data: payload.data.map((post) => withReadingTime(post)) };
}

export async function getReviewBySlug(slug: string): Promise<Post | null> {
  const payload = await request(`/reviews/${slug}`, postSchema.nullable());
  return payload ? withReadingTime(payload) : null;
}

export async function getDeals(params?: { category?: string }): Promise<Deal[]> {
  return request('/deals', z.array(dealSchema), params);
}

export async function getDealBySlug(slug: string): Promise<Deal | null> {
  return request(`/deals/${slug}`, dealSchema.nullable());
}

export async function getPromos(params?: { category?: string }): Promise<Promo[]> {
  return request('/promos', z.array(promoSchema), params);
}

export async function getPromoBySlug(slug: string): Promise<Promo | null> {
  return request(`/promos/${slug}`, promoSchema.nullable());
}

export async function getProducts(params?: { category?: string }): Promise<Product[]> {
  return request('/products', z.array(productSchema), params);
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  return request(`/products/${slug}`, productSchema.nullable());
}

export async function getPostsByAuthor(authorSlug: string): Promise<PaginatedResponse<Post>> {
  const payload = await request(`/authors/${authorSlug}/posts`, paginatedPostSchema);
  return { ...payload, data: payload.data.map((post) => withReadingTime(post)) };
}

export async function getRelatedPosts(slug: string, category: string): Promise<Post[]> {
  const payload = await request('/posts/related', z.array(postSchema), { slug, category, limit: 3 });
  return payload.map((post) => withReadingTime(post));
}

export async function getAllCategories(): Promise<string[]> {
  return request('/categories', z.array(z.string()));
}

export async function getAllTags(): Promise<string[]> {
  return request('/tags', z.array(z.string()));
}

export async function getAllAuthors(): Promise<Author[]> {
  return request('/authors', z.array(authorSchema));
}
