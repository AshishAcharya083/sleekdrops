// Publisher — writes the finished article into Cloudflare D1 (the same
// tables the website builds from) and fires the content-updated dispatch
// that rebuilds the site. No LLM involved: this stage is deterministic.
//
// Re-entrant by design: a retry-forward run passes through here again, as does
// a republish and the admin-feedback loop. The D1 writes are slug upserts and
// were always safe to repeat; what was not safe is everything that is only
// true the first time - the publication date the site prints, and the rebuild
// dispatch. Both are keyed on the article now: `pub_date` is stamped once and
// reused, and the dispatch fires only when the content that reaches D1 is
// actually different from what was pushed last time.
import { createHash } from 'node:crypto';
import { getSetting, q } from '../db/pool.js';
import { d1Query } from '../tools/d1.js';
import { dispatchContentUpdated } from '../tools/github.js';
import { isReviewStale, PUBLISHER_REVIEW_STALE_ERROR } from '../pipeline/retry.js';
import type { ArticleRow } from '../pipeline/types.js';

export interface PublishResult {
  slug: string;
  d1Status: 'published' | 'draft';
  /** Whether *this* pass rebuilt the site. A repeat pass over unchanged
   *  content returns false. */
  dispatched: boolean;
}

/**
 * What the last pass pushed to D1, as one comparable value. The D1 status is
 * part of it as well as the content: a piece parked as a draft and later
 * published again is unchanged text that still has to rebuild the site.
 */
function publishedDigest(
  slug: string,
  d1Status: string,
  frontmatter: unknown,
  body: string,
): string {
  return createHash('sha256')
    .update(`${slug}\n${d1Status}\n${JSON.stringify(frontmatter)}\n${body}`)
    .digest('hex');
}

/**
 * The publish receipt for this article: the date it was first published (null
 * until then) and the digest of the last version pushed live.
 */
async function publishState(
  articleId: string,
): Promise<{ pub_date: string | null; published_digest: string | null }> {
  // Formatted in SQL: `pg` reads a DATE back as a Date at *local* midnight, so
  // formatting it here would move the published date a day in any timezone
  // ahead of UTC.
  const [row] = await q<{ pub_date: string | null; published_digest: string | null }>(
    `SELECT to_char(pub_date, 'YYYY-MM-DD') pub_date, published_digest
       FROM articles WHERE id = $1`,
    [articleId],
  );
  return { pub_date: row?.pub_date ?? null, published_digest: row?.published_digest ?? null };
}

export async function runPublisher(article: ArticleRow): Promise<PublishResult> {
  const slug = article.slug!;
  const frontmatter = article.frontmatter!;
  const body = article.draft_md!;
  const links = article.affiliate_links ?? [];

  // The API refuses to queue a publish whose review is stale, but a publish
  // can already be queued when a retry regenerates the draft behind it. This
  // site's promise is that every review-branded piece was reviewed, so the
  // last word on that is here, where the push actually happens.
  if (await isReviewStale(article.id)) throw new Error(PUBLISHER_REVIEW_STALE_ERROR);

  const publishMode = await getSetting<string>('publish_mode', 'approval');
  // "draft" mode parks the row in D1 unpublished; anything else goes live.
  const d1Status = publishMode === 'draft' ? 'draft' : 'published';

  // Affiliate links first — fetch-content.mjs fails the site build if a
  // /go/ slug in a published body has no matching row.
  //
  // `affiliate_links` is one site-wide slug → destination map, and a product
  // slug is deterministic, so two articles covering the same product write the
  // same row. A dossier-backed row wins that collision: it may carry an ASIN
  // verified against the live marketplace, and a healed row is a search term
  // rebuilt from one draft's own words. So a healed row only ever fills a slug
  // nothing has claimed yet - it must not send the readers of an
  // already-published article to a search page instead of the product page
  // they had.
  for (const link of links) {
    const onSlugTaken = link.healed
      ? 'DO NOTHING'
      : `DO UPDATE SET
           default_url = excluded.default_url,
           regions_json = excluded.regions_json,
           note = excluded.note,
           updated_at = datetime('now')`;
    await d1Query(
      `INSERT INTO affiliate_links (slug, default_url, regions_json, note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
       ON CONFLICT (slug) ${onSlugTaken}`,
      [link.slug, link.default_url, link.regions_json ? JSON.stringify(link.regions_json) : null, link.note ?? null],
    );
  }

  const state = await publishState(article.id);
  // Stamped on the first pass and reused verbatim after it: a reader must not
  // see the publication date move because a stage was re-run.
  const pubDate =
    state.pub_date ??
    (typeof frontmatter.pubDate === 'string'
      ? frontmatter.pubDate
      : new Date().toISOString().slice(0, 10));

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
      String(frontmatter.author ?? 'desk'),
      pubDate,
      JSON.stringify(frontmatter),
      body,
    ],
  );

  // One dispatch per published version. Re-entering publish with the same
  // content (a retry that reached here again, a republish after a no-op edit)
  // upserts the same row and must not queue another site rebuild.
  const digest = publishedDigest(slug, d1Status, frontmatter, body);
  await q('UPDATE articles SET pub_date = $2, updated_at = now() WHERE id = $1', [
    article.id,
    pubDate,
  ]);

  const dispatched = d1Status === 'published' && digest !== state.published_digest;
  if (dispatched) await dispatchContentUpdated();
  // Recorded only once the rebuild has actually been asked for, so a failed
  // dispatch is retried by the next pass rather than silently marked as
  // delivered.
  await q('UPDATE articles SET published_digest = $2, updated_at = now() WHERE id = $1', [
    article.id,
    digest,
  ]);

  return { slug, d1Status, dispatched };
}
