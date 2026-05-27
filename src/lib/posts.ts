/**
 * Thin content-collection helpers.
 *
 * Pages should call these instead of using `getCollection('blog')` directly
 * so the filtering / sorting / draft-handling logic lives in one place. If
 * the content source ever moves from a local collection to the backend API,
 * this is the only file that needs to change.
 */

import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

function isLivePost(post: BlogPost): boolean {
  if (post.data.draft) return false;
  if (import.meta.env.DEV) return true;
  return post.data.pubDate.getTime() <= Date.now();
}

function byNewest(a: BlogPost, b: BlogPost): number {
  return b.data.pubDate.getTime() - a.data.pubDate.getTime();
}

/** All live posts, newest first. */
export async function getAllPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', isLivePost);
  return posts.sort(byNewest);
}

export async function getFeaturedPost(): Promise<BlogPost | undefined> {
  const posts = await getAllPosts();
  return posts.find((p) => p.data.featured);
}

export async function getPostsByCategory(category: string): Promise<BlogPost[]> {
  const posts = await getAllPosts();
  return posts.filter(
    (p) => p.data.category.toLowerCase() === category.toLowerCase(),
  );
}

export async function getPostsByAuthor(authorId: string): Promise<BlogPost[]> {
  const posts = await getAllPosts();
  return posts.filter((p) => p.data.author === authorId);
}

export async function getPostsByTag(tag: string): Promise<BlogPost[]> {
  const posts = await getAllPosts();
  return posts.filter((p) =>
    p.data.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
  );
}

export async function getPostsByType(
  postType: BlogPost['data']['postType'],
): Promise<BlogPost[]> {
  const posts = await getAllPosts();
  return posts.filter((p) => p.data.postType === postType);
}

/** All distinct tags across live posts, alphabetised. */
export async function getAllTags(): Promise<string[]> {
  const posts = await getAllPosts();
  const tagSet = new Set<string>();
  for (const post of posts) {
    for (const tag of post.data.tags) tagSet.add(tag);
  }
  return [...tagSet].sort((a, b) => a.localeCompare(b));
}

/**
 * Up to N related posts: prefer same-category, fall back to anything else.
 */
export async function getRelatedPosts(
  current: BlogPost,
  limit = 3,
): Promise<BlogPost[]> {
  const all = await getAllPosts();
  const others = all.filter((p) => p.slug !== current.slug);
  const sameCat = others.filter((p) => p.data.category === current.data.category);
  const rest = others.filter((p) => p.data.category !== current.data.category);
  return [...sameCat, ...rest].slice(0, limit);
}
