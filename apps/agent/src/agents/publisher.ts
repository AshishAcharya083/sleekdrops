// Publisher — writes the finished article into Cloudflare D1 (the same
// tables the website builds from) and fires the content-updated dispatch
// that rebuilds the site. No LLM involved: this stage is deterministic.
import { getSetting } from '../db/pool.js';
import { d1Query } from '../tools/d1.js';
import { dispatchContentUpdated } from '../tools/github.js';
import type { ArticleRow } from '../pipeline/types.js';

export interface PublishResult {
  slug: string;
  d1Status: 'published' | 'draft';
  dispatched: boolean;
}

export async function runPublisher(article: ArticleRow): Promise<PublishResult> {
  const slug = article.slug!;
  const frontmatter = article.frontmatter!;
  const body = article.draft_md!;
  const links = article.affiliate_links ?? [];

  const publishMode = await getSetting<string>('publish_mode', 'approval');
  // "draft" mode parks the row in D1 unpublished; anything else goes live.
  const d1Status = publishMode === 'draft' ? 'draft' : 'published';

  // Affiliate links first — fetch-content.mjs fails the site build if a
  // /go/ slug in a published body has no matching row.
  for (const link of links) {
    await d1Query(
      `INSERT INTO affiliate_links (slug, default_url, regions_json, note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
       ON CONFLICT (slug) DO UPDATE SET
         default_url = excluded.default_url,
         regions_json = excluded.regions_json,
         note = excluded.note,
         updated_at = datetime('now')`,
      [link.slug, link.default_url, link.regions_json ? JSON.stringify(link.regions_json) : null, link.note ?? null],
    );
  }

  await d1Query(
    `INSERT INTO posts (slug, status, title, category, post_type, author, pub_date,
                        frontmatter_json, body_md, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))
     ON CONFLICT (slug) DO UPDATE SET
       status = excluded.status,
       title = excluded.title,
       category = excluded.category,
       post_type = excluded.post_type,
       author = excluded.author,
       pub_date = excluded.pub_date,
       frontmatter_json = excluded.frontmatter_json,
       body_md = excluded.body_md,
       updated_at = datetime('now')`,
    [
      slug,
      d1Status,
      String(frontmatter.title ?? article.title),
      article.category,
      article.post_type,
      String(frontmatter.author ?? 'mira'),
      String(frontmatter.pubDate ?? new Date().toISOString().slice(0, 10)),
      JSON.stringify(frontmatter),
      body,
    ],
  );

  let dispatched = false;
  if (d1Status === 'published') {
    await dispatchContentUpdated();
    dispatched = true;
  }
  return { slug, d1Status, dispatched };
}
