import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getAllPosts } from '@lib/posts';
import { getAuthor } from '@data/authors';

export async function GET(context: APIContext): Promise<Response> {
  const posts = await getAllPosts();
  return rss({
    title: 'SleekDrops',
    description:
      "Exclusive deals dropping daily. Honest product reviews, side-by-side comparisons, and one daily deal worth your inbox.",
    site: context.site ?? 'https://sleekdrops.com',
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.dek,
      pubDate: post.data.pubDate,
      link: `/blog/${post.slug}`,
      categories: [post.data.category, ...post.data.tags],
      author: getAuthor(post.data.author).name,
    })),
    customData: '<language>en-us</language>',
  });
}
