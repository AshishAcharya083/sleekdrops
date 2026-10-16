// The publish target's content: the posts and affiliate_links tables a
// platform's website builds from (apps/web/scripts/fetch-content.mjs reads the
// same two). Migration 019 creates them in the pipeline's own database, which
// is where SleekDrops publishes; another platform names a database of its own.
//
// Every call names the database it runs against: each platform has its own,
// and there is no default one to land in.
import pg from 'pg';
import { goSlugsIn } from '../content/contract.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import type { ResolvedPublishTarget } from '../platform/publishTarget.js';

const log = createLogger('content-store');

export type ContentTarget = Pick<ResolvedPublishTarget, 'contentDatabaseUrl'>;

/** One pool per content database that is not the pipeline's own. */
const contentPools = new Map<string, pg.Pool>();

/**
 * The pool a target's statements run on. The pipeline's own pool when the
 * target is the pipeline's database - SleekDrops', whose variable is
 * DATABASE_URL itself - so publishing opens no second set of connections to it.
 */
export function contentPool(target: ContentTarget): pg.Pool {
  if (target.contentDatabaseUrl === config.databaseUrl) return pool;
  let own = contentPools.get(target.contentDatabaseUrl);
  if (!own) {
    // Small, and never what keeps the process alive: a platform publishes a
    // few statements at a time, and the pipeline's pool is the one that matters.
    own = new pg.Pool({ connectionString: target.contentDatabaseUrl, max: 4, allowExitOnIdle: true });
    own.on('error', (err) => {
      log.warn('idle content database connection dropped', { error: err });
    });
    contentPools.set(target.contentDatabaseUrl, own);
  }
  return own;
}

/** Close every content pool this process opened (never the pipeline's own). */
export async function endContentPools(): Promise<void> {
  const open = [...contentPools.values()];
  contentPools.clear();
  await Promise.all(open.map((own) => own.end()));
}

export async function contentQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  target: ContentTarget,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await contentPool(target).query<T>(sql, params);
  return res.rows;
}

export interface PublishedPostRow {
  slug: string;
  status: string;
  title: string;
  category: string;
  post_type: string;
  author: string;
  /** YYYY-MM-DD. */
  pub_date: string;
  /** UTC, `YYYY-MM-DD HH:MM:SS` - the shape the admin list has always shown. */
  updated_at: string;
  /** Pulled out of frontmatter_json so the admin list can show the hero. */
  hero_image: string | null;
  hero_alt: string | null;
}

// Dates are formatted in SQL: `pg` reads a DATE back as a Date at *local*
// midnight, so formatting it here would move it a day in any timezone ahead of
// UTC (see publisher.ts).

/** Every post row (published and draft) — the admin "Published" list. */
export async function listPosts(target: ContentTarget): Promise<PublishedPostRow[]> {
  return contentQuery<PublishedPostRow>(
    target,
    `SELECT slug, status, title, category, post_type, author,
            to_char(pub_date, 'YYYY-MM-DD') pub_date,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') updated_at,
            frontmatter_json ->> 'heroImage' hero_image,
            frontmatter_json ->> 'heroAlt' hero_alt
     FROM posts ORDER BY posts.pub_date DESC, slug`,
  );
}

/** A published body, for the scanner's cross-corpus repetition metrics. */
export interface PublishedBodyRow {
  slug: string;
  title: string;
  body_md: string;
  pub_date: string | null;
}

/**
 * The most recently published bodies, newest first. The content store is
 * where published content lives, so it is also the corpus: no mirror to keep
 * in sync, and articles that went out before the scanner existed are in it
 * already.
 */
export async function fetchPublishedBodies(
  target: ContentTarget,
  limit: number,
  excludeSlug?: string | null,
): Promise<PublishedBodyRow[]> {
  return contentQuery<PublishedBodyRow>(
    target,
    `SELECT slug, title, body_md, to_char(pub_date, 'YYYY-MM-DD') pub_date
     FROM posts
     WHERE status = 'published' AND body_md IS NOT NULL AND slug <> $1
     ORDER BY posts.pub_date DESC, slug
     LIMIT $2`,
    [excludeSlug ?? '', limit],
  );
}

export interface PostHero {
  heroImage: string | null;
  heroAlt: string | null;
}

/**
 * Set (or clear) the hero fields inside a post's frontmatter, leaving every
 * other key untouched. heroAlt is deleted rather than set to null: the
 * website's frontmatter schema takes an optional string, and a null would fail
 * the site build. Accepts the frontmatter as the object a JSONB column reads
 * back as, or as JSON text; malformed text throws instead of being overwritten
 * — the rest of that frontmatter is the only copy of the post's title, dek and
 * tags.
 */
export function patchHeroFrontmatter(
  frontmatter: string | Record<string, unknown>,
  hero: PostHero,
): Record<string, unknown> {
  let parsed: unknown = frontmatter;
  if (typeof frontmatter === 'string') {
    try {
      parsed = JSON.parse(frontmatter);
    } catch {
      throw new Error('the post\'s frontmatter is not valid JSON — refusing to overwrite it');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the post\'s frontmatter is not an object — refusing to overwrite it');
  }
  const patched = { ...(parsed as Record<string, unknown>) };
  delete patched.heroAlt;
  if (hero.heroImage) {
    patched.heroImage = hero.heroImage;
    if (hero.heroAlt) patched.heroAlt = hero.heroAlt;
  } else {
    delete patched.heroImage;
  }
  return patched;
}

/** The hero a live post currently carries, or null when there is no such post. */
export async function getPostHero(target: ContentTarget, slug: string): Promise<PostHero | null> {
  const [post] = await contentQuery<{ hero_image: string | null; hero_alt: string | null }>(
    target,
    `SELECT frontmatter_json ->> 'heroImage' hero_image,
            frontmatter_json ->> 'heroAlt' hero_alt
     FROM posts WHERE slug = $1`,
    [slug],
  );
  return post ? { heroImage: post.hero_image, heroAlt: post.hero_alt } : null;
}

/**
 * Rewrite a live post's hero image in place. Deliberately does NOT stamp
 * `updatedDate`: swapping a photo is not an editorial revision, and the site
 * shows that date to readers.
 */
export async function setPostHero(target: ContentTarget, slug: string, hero: PostHero): Promise<boolean> {
  const [post] = await contentQuery<{ frontmatter_json: Record<string, unknown> }>(
    target,
    'SELECT frontmatter_json FROM posts WHERE slug = $1',
    [slug],
  );
  if (!post) return false;
  const frontmatter = patchHeroFrontmatter(post.frontmatter_json, hero);
  await contentQuery(target, 'UPDATE posts SET frontmatter_json = $2::jsonb, updated_at = now() WHERE slug = $1', [
    slug,
    JSON.stringify(frontmatter),
  ]);
  return true;
}

/**
 * Delete a post so the next site build no longer includes it, plus any
 * pipeline-authored affiliate links that no remaining post references.
 * (Hand-curated link rows — no "used by" note — are left alone: static pages
 * like deals/promos may point at them.)
 */
export async function deletePost(
  target: ContentTarget,
  slug: string,
): Promise<{ removedLinks: string[] } | null> {
  const [post] = await contentQuery<{ body_md: string }>(
    target,
    'SELECT body_md FROM posts WHERE slug = $1',
    [slug],
  );
  if (!post) return null;
  const candidates = goSlugsIn(post.body_md ?? '');

  await contentQuery(target, 'DELETE FROM posts WHERE slug = $1', [slug]);

  const removedLinks: string[] = [];
  if (candidates.length > 0) {
    const remaining = await contentQuery<{ body_md: string }>(target, 'SELECT body_md FROM posts');
    const stillUsed = new Set(remaining.flatMap((r) => goSlugsIn(r.body_md ?? '')));
    for (const linkSlug of candidates) {
      if (stillUsed.has(linkSlug)) continue;
      const deleted = await contentQuery<{ slug: string }>(
        target,
        "DELETE FROM affiliate_links WHERE slug = $1 AND note LIKE '%used by%' RETURNING slug",
        [linkSlug],
      );
      if (deleted.length > 0) removedLinks.push(linkSlug);
    }
  }
  return { removedLinks };
}

/** Slugs + titles of every post already published or parked — the "topics we've used" list. */
export async function fetchPublishedPosts(
  target: ContentTarget,
): Promise<Array<{ slug: string; title: string }>> {
  const rows = await contentQuery<{ slug: string; title: string | null }>(
    target,
    "SELECT slug, frontmatter_json ->> 'title' title FROM posts ORDER BY slug",
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title ?? r.slug }));
}
