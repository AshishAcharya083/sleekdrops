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
}

/** Every post row in D1 (published and draft) — the admin "Published" list. */
export async function listD1Posts(): Promise<PublishedPostRow[]> {
  return d1Query<PublishedPostRow>(
    `SELECT slug, status, title, category, post_type, author, pub_date, updated_at
     FROM posts ORDER BY pub_date DESC, slug`,
  );
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
