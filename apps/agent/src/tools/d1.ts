// Cloudflare D1 REST client — the publish target. The website's build step
// (apps/web/scripts/fetch-content.mjs) reads the same two tables.
import { goSlugsIn } from '../content/contract.js';
import { config } from '../config.js';

export async function d1Query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { accountId, databaseId, token } = config.d1;
  if (!accountId || !databaseId || !token) {
    throw new Error(
      'Cloudflare D1 env missing — need CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_TOKEN',
    );
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = (await res.json()) as {
    success?: boolean;
    result?: Array<{ results: T[] }>;
    errors?: unknown;
  };
  if (!res.ok || !json.success) {
    throw new Error(`D1 query failed (HTTP ${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result?.[0]?.results ?? [];
}

export interface PublishedPostRow {
  slug: string;
  status: string;
  title: string;
  category: string;
  post_type: string;
  author: string;
  pub_date: string;
  updated_at: string;
  /** Pulled out of frontmatter_json so the admin list can show the hero. */
  hero_image: string | null;
  hero_alt: string | null;
}

/** Every post row in D1 (published and draft) — the admin "Published" list. */
export async function listD1Posts(): Promise<PublishedPostRow[]> {
  return d1Query<PublishedPostRow>(
    `SELECT slug, status, title, category, post_type, author, pub_date, updated_at,
            json_extract(frontmatter_json, '$.heroImage') hero_image,
            json_extract(frontmatter_json, '$.heroAlt') hero_alt
     FROM posts ORDER BY pub_date DESC, slug`,
  );
}

export interface PostHero {
  heroImage: string | null;
  heroAlt: string | null;
}

/**
 * Set (or clear) the hero fields inside a post's frontmatter JSON, leaving
 * every other key untouched. heroAlt is deleted rather than set to null: the
 * website's frontmatter schema takes an optional string, and a null would fail
 * the site build. Malformed JSON throws instead of being overwritten — the rest
 * of that frontmatter is the only copy of the post's title, dek and tags.
 */
export function patchHeroFrontmatter(frontmatterJson: string, hero: PostHero): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frontmatterJson);
  } catch {
    throw new Error('the post\'s frontmatter is not valid JSON — refusing to overwrite it');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the post\'s frontmatter is not an object — refusing to overwrite it');
  }
  const frontmatter = { ...(parsed as Record<string, unknown>) };
  delete frontmatter.heroAlt;
  if (hero.heroImage) {
    frontmatter.heroImage = hero.heroImage;
    if (hero.heroAlt) frontmatter.heroAlt = hero.heroAlt;
  } else {
    delete frontmatter.heroImage;
  }
  return frontmatter;
}

/** The hero a live post currently carries, or null when there is no such post. */
export async function getD1PostHero(slug: string): Promise<PostHero | null> {
  const [post] = await d1Query<{ hero_image: string | null; hero_alt: string | null }>(
    `SELECT json_extract(frontmatter_json, '$.heroImage') hero_image,
            json_extract(frontmatter_json, '$.heroAlt') hero_alt
     FROM posts WHERE slug = ?1`,
    [slug],
  );
  return post ? { heroImage: post.hero_image, heroAlt: post.hero_alt } : null;
}

/**
 * Rewrite a live post's hero image in place. Deliberately does NOT stamp
 * `updatedDate`: swapping a photo is not an editorial revision, and the site
 * shows that date to readers.
 */
export async function setD1PostHero(slug: string, hero: PostHero): Promise<boolean> {
  const [post] = await d1Query<{ frontmatter_json: string }>(
    'SELECT frontmatter_json FROM posts WHERE slug = ?1',
    [slug],
  );
  if (!post) return false;
  const frontmatter = patchHeroFrontmatter(post.frontmatter_json, hero);
  await d1Query("UPDATE posts SET frontmatter_json = ?2, updated_at = datetime('now') WHERE slug = ?1", [
    slug,
    JSON.stringify(frontmatter),
  ]);
  return true;
}

/**
 * Delete a post from D1 so the next site build no longer includes it, plus any
 * pipeline-authored affiliate links that no remaining post references.
 * (Hand-curated link rows — no "used by" note — are left alone: static pages
 * like deals/promos may point at them.)
 */
export async function deleteD1Post(
  slug: string,
): Promise<{ removedLinks: string[] } | null> {
  const [post] = await d1Query<{ body_md: string }>(
    'SELECT body_md FROM posts WHERE slug = ?1',
    [slug],
  );
  if (!post) return null;
  const candidates = goSlugsIn(post.body_md ?? '');

  await d1Query('DELETE FROM posts WHERE slug = ?1', [slug]);

  const removedLinks: string[] = [];
  if (candidates.length > 0) {
    const remaining = await d1Query<{ body_md: string }>('SELECT body_md FROM posts');
    const stillUsed = new Set(remaining.flatMap((r) => goSlugsIn(r.body_md ?? '')));
    for (const linkSlug of candidates) {
      if (stillUsed.has(linkSlug)) continue;
      const deleted = await d1Query<{ slug: string }>(
        "DELETE FROM affiliate_links WHERE slug = ?1 AND note LIKE '%used by%' RETURNING slug",
        [linkSlug],
      );
      if (deleted.length > 0) removedLinks.push(linkSlug);
    }
  }
  return { removedLinks };
}

/** Slugs + titles of every post already in D1 — the "topics we've used" list. */
export async function fetchPublishedPosts(): Promise<Array<{ slug: string; title: string }>> {
  const rows = await d1Query<{ slug: string; frontmatter_json: string }>(
    'SELECT slug, frontmatter_json FROM posts ORDER BY slug',
  );
  return rows.map((r) => {
    let title = r.slug;
    try {
      title = (JSON.parse(r.frontmatter_json) as { title?: string }).title ?? r.slug;
    } catch {
      /* tolerate malformed rows */
    }
    return { slug: r.slug, title };
  });
}
