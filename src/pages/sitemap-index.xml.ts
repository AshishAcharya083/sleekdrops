import type { APIRoute } from 'astro';
import { getAllAuthors, getAllCategories, getAllTags, getDeals, getPosts, getPromos, getReviews } from '../lib/api';

const site = (import.meta.env.SITE_URL ?? 'https://sleekdrops.com').replace(/\/$/, '');

export const GET: APIRoute = async () => {
  const [posts, categories, tags, authors, promos] = await Promise.all([
    getPosts({ page: 1, limit: 1000 }),
    getAllCategories(),
    getAllTags(),
    getAllAuthors(),
    getPromos(),
  ]);
  const [reviews, deals] = await Promise.all([
    getReviews({ page: 1 }),
    getDeals(),
  ]);

  const urls = [
    '/',
    '/blog',
    '/reviews',
    '/deals',
    '/about',
    '/privacy',
    '/disclaimer',
    ...posts.data.map((post) => `/blog/${post.slug}`),
    ...reviews.data.map((post) => `/reviews/${post.slug}`),
    ...categories.map((category) => `/category/${category}`),
    ...tags.map((tag) => `/tag/${tag}`),
    ...authors.map((author) => `/author/${author.slug}`),
    ...deals.map((deal) => `/deals/${deal.slug}`),
    ...promos.map((promo) => `/promos/${promo.slug}`),
    '/promos',
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from(new Set(urls))
  .map((url) => `  <url><loc>${site}${url}</loc></url>`)
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
};
