export interface Post {
  id: string;
  title: string;
  slug: string;
  description: string;
  content: string;
  postType: 'article' | 'review' | 'guide' | 'roundup';
  category: string;
  tags: string[];
  author: string;
  featuredImage?: string;
  publishedAt: string;
  updatedAt?: string;
  readingTime?: number;
  affiliateLinks: Record<string, string>;
  seoTitle?: string;
  seoDescription?: string;
  schemaType: 'Article' | 'BlogPosting' | 'FAQPage';
  noindex?: boolean;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  brand?: string;
  description: string;
  category: string;
  affiliateUrl: string;
  originalPrice?: number;
  salePrice?: number;
  currency: string;
  rating?: number;
  pros: string[];
  cons: string[];
  imageUrl?: string;
  inStock: boolean;
}

export interface Deal {
  id: string;
  brandName: string;
  slug: string;
  promoCode?: string;
  dealTitle: string;
  description: string;
  terms?: string;
  affiliateUrl: string;
  category: string;
  originalPrice?: number;
  dealPrice?: number;
  discountPct?: number;
  isActive: boolean;
  expiresAt?: string;
  logoUrl?: string;
}

export interface Promo {
  id: string;
  operatorName: string;
  slug: string;
  promoCode?: string;
  promoTitle: string;
  description: string;
  terms?: string;
  affiliateUrl: string;
  category: string;
  isActive: boolean;
  expiresAt?: string;
  rating?: number;
  logoUrl?: string;
}

export interface Author {
  id: string;
  slug: string;
  name: string;
  bio?: string;
  avatarUrl?: string;
  twitterUrl?: string;
  role: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}

export interface MetaPayload {
  title: string;
  description: string;
  canonicalUrl: string;
  image?: string;
  type?: 'website' | 'article';
  noindex?: boolean;
  prevUrl?: string;
  nextUrl?: string;
}

export interface BreadcrumbItem {
  name: string;
  href: string;
}
