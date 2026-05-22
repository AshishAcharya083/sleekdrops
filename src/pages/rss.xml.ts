import type { APIContext } from 'astro';
import rss from '@astrojs/rss';
import { getPosts } from '../lib/api';

export async function GET(context: APIContext) {
  const posts = await getPosts({ page: 1, limit: 1000 });
  return rss({
    title: 'SleekDrops RSS Feed',
    description: 'Product reviews, deals, promo codes, and buying guides.',
    site: context.site ?? 'https://sleekdrops.com',
    items: posts.data.map((post) => ({
      title: post.title,
      description: post.description,
      link: `/blog/${post.slug}`,
      pubDate: new Date(post.publishedAt),
      content: post.content,
    })),
  });
}
