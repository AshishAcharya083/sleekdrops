import type { APIRoute } from 'astro';
import { getAllPosts } from '@lib/posts';
import { getAuthor } from '@data/authors';
import type { SearchDoc } from '@lib/search';

/**
 * Static search index. Pre-rendered to /search-index.json at build time (the
 * site is `output: 'static'`), then fetched once by the blog search UI. Mirrors
 * the fields BlogSearch ranks and renders — keep it in sync with SearchDoc.
 */
export const GET: APIRoute = async () => {
  const posts = await getAllPosts();
  const index: SearchDoc[] = posts.map((post) => ({
    title: post.data.title,
    dek: post.data.dek,
    category: post.data.category,
    tags: post.data.tags,
    author: getAuthor(post.data.author).name,
    url: `/blog/${post.slug}`,
  }));
  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
