// Cloudflare D1 REST client — the publish target. The website's build step
// (apps/web/scripts/fetch-content.mjs) reads the same two tables.
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
