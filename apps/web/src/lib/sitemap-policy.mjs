/**
 * What goes in the sitemap, and with what `lastmod`.
 *
 * Two problems this solves, both found on the live site in September 2026:
 *
 *  1. The sitemap had no `lastmod` at all. Google and Bing both say they use it
 *     when it is accurate (and ignore changefreq/priority), and Bing names it as
 *     the signal that decides how quickly a change reaches its index and the AI
 *     answers built on it. Every date here is derived from the posts themselves -
 *     `updatedDate ?? pubDate` for a post, the newest post a listing holds for
 *     the listing - so it moves only when content actually moved.
 *  2. 84 of the 124 URLs were tag pages, 11 of 12 sampled holding a single post.
 *     A tag page with fewer than MIN_TAG_POSTS posts is left out of the sitemap
 *     here and `noindex`ed by the page (the two read the same threshold), and the
 *     `/reviews` hub is left out while it has nothing to list.
 *
 * Plain ESM because `astro.config.mjs` imports it at config-load time, before
 * anything is built; the pages import the same module so the threshold cannot
 * drift between "in the sitemap" and "indexable". Posts are read straight from
 * the markdown `scripts/fetch-content.mjs` writes, whose frontmatter is one
 * `key: <JSON>` line per field - see `toFrontmatterYaml` there.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A tag page needs this many live posts before it is worth a crawler's time. */
export const MIN_TAG_POSTS = 3;

/** True when a tag archive with this many posts should be indexed and listed. */
export function isIndexableTag(postCount) {
  return postCount >= MIN_TAG_POSTS;
}

/** Same rule as `slugify` in ./format.ts; duplicated because this file is plain ESM. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The frontmatter block of one generated post. Values are JSON per line (the
 * writer's format); anything that is not JSON is kept as the raw string, so a
 * hand-edited file degrades to "no date" rather than to a crash.
 */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
  return data;
}

function asDate(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The post as the policy needs it. `live` mirrors `isLivePost` in ./posts.ts. */
export function toPostRecord(slug, data, now = new Date()) {
  const pubDate = asDate(data.pubDate);
  const updatedDate = asDate(data.updatedDate);
  return {
    slug,
    pubDate,
    updatedDate,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    category: typeof data.category === 'string' ? data.category : '',
    author: typeof data.author === 'string' ? data.author : '',
    postType: typeof data.postType === 'string' ? data.postType : 'article',
    live: data.draft !== true && pubDate !== null && pubDate.getTime() <= now.getTime(),
  };
}

/** Every live post under `blogDir`; an absent directory (astro check before fetch) is simply empty. */
export function readContentIndex(blogDir, now = new Date()) {
  if (!existsSync(blogDir)) return [];
  return readdirSync(blogDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const data = parseFrontmatter(readFileSync(join(blogDir, file), 'utf8'));
      return data ? toPostRecord(file.slice(0, -'.md'.length), data, now) : null;
    })
    .filter((post) => post !== null && post.live);
}

/** `YYYY-MM-DD` - the W3C date form Google and Bing accept for lastmod. */
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** The most recent change across a set of posts, or undefined for an empty set. */
export function latestChange(posts) {
  let latest = null;
  for (const post of posts) {
    const changed = post.updatedDate ?? post.pubDate;
    if (changed && (!latest || changed.getTime() > latest.getTime())) latest = changed;
  }
  return latest ? isoDay(latest) : undefined;
}

const PAGE_SUFFIX = '(?:/\\d+)?';

/**
 * The `filter` and `serialize` hooks for @astrojs/sitemap, plus `lastmodFor` so
 * the mapping from a route to a date is testable on its own.
 */
export function createSitemapPolicy(posts) {
  const bySlug = new Map(posts.map((post) => [post.slug, post]));
  const group = (keyOf) => {
    const map = new Map();
    for (const post of posts) {
      for (const key of keyOf(post)) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(post);
      }
    }
    return map;
  };
  const byTag = group((post) => post.tags.map(slugify));
  const byCategory = group((post) => (post.category ? [slugify(post.category)] : []));
  const byAuthor = group((post) => (post.author ? [post.author] : []));
  const byType = group((post) => [post.postType]);

  const pathOf = (url) => {
    const pathname = url.startsWith('http') ? new URL(url).pathname : url;
    return pathname.replace(/\/+$/, '') || '/';
  };
  const first = (re, path) => re.exec(path)?.[1];

  const lastmodFor = (path) => {
    if (path === '/' || new RegExp(`^/blog${PAGE_SUFFIX}$`).test(path)) return latestChange(posts);
    const post = first(/^\/blog\/([^/]+)$/, path);
    if (post !== undefined) {
      const record = bySlug.get(post);
      return record ? latestChange([record]) : undefined;
    }
    const category = first(new RegExp(`^/category/([^/]+)${PAGE_SUFFIX}$`), path);
    if (category !== undefined) return latestChange(byCategory.get(category) ?? []);
    const tag = first(new RegExp(`^/tag/([^/]+)${PAGE_SUFFIX}$`), path);
    if (tag !== undefined) return latestChange(byTag.get(tag) ?? []);
    const author = first(/^\/author\/([^/]+)$/, path);
    if (author !== undefined) return latestChange(byAuthor.get(author) ?? []);
    if (new RegExp(`^/reviews${PAGE_SUFFIX}$`).test(path)) return latestChange(byType.get('review') ?? []);
    if (new RegExp(`^/guides${PAGE_SUFFIX}$`).test(path)) return latestChange(byType.get('guide') ?? []);
    return undefined;
  };

  return {
    lastmodFor,
    /** @astrojs/sitemap `filter`: false drops the URL from the sitemap. */
    filter(url) {
      const path = pathOf(url);
      const tag = first(new RegExp(`^/tag/([^/]+)${PAGE_SUFFIX}$`), path);
      if (tag !== undefined) return isIndexableTag(byTag.get(tag)?.length ?? 0);
      if (new RegExp(`^/reviews${PAGE_SUFFIX}$`).test(path)) return (byType.get('review')?.length ?? 0) > 0;
      return true;
    },
    /** @astrojs/sitemap `serialize`: the entry with a lastmod when one is known. */
    serialize(item) {
      const lastmod = lastmodFor(pathOf(item.url));
      return lastmod ? { ...item, lastmod } : item;
    },
  };
}
