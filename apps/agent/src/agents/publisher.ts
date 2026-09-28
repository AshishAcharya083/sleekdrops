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
import { todayInSydney } from '../content/contract.js';
import { getSetting, q } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import { d1Query } from '../tools/d1.js';
import { dispatchContentUpdated } from '../tools/github.js';
import { claimHeld, LeaseLostError, updateClaimed } from '../pipeline/lease.js';
import { isReviewStale, PUBLISHER_REVIEW_STALE_ERROR } from '../pipeline/retry.js';
import type { ArticleRow } from '../pipeline/types.js';

const log = createLogger('publisher');

export interface PublishOptions {
  /**
   * The publish mode this pass runs under, instead of reading the admin
   * setting. Only a test passes it: `publish_mode` is one global settings row,
   * so a suite that flipped it to drive the draft path would be flipping it
   * under every other suite running against the same database at the time.
   */
  publishMode?: string;
}

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

/**
 * The publish receipt, written the way every other stage writes to its
 * article: only while this run still holds the claim it started under. The
 * push to D1 has already happened by the time these run, so a lost claim is
 * noted rather than thrown - the live post stands, and the article row now
 * belongs to whatever replaced this run.
 */
async function stamp(article: ArticleRow, fields: Record<string, unknown>): Promise<void> {
  if (await updateClaimed(article, fields)) return;
  log.warn('publish receipt dropped: the article moved on while the publish ran', {
    article_id: article.id,
    columns: Object.keys(fields),
  });
}

export async function runPublisher(
  article: ArticleRow,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const slug = article.slug!;
  const frontmatter = article.frontmatter!;
  const body = article.draft_md!;
  const links = article.affiliate_links ?? [];

  // The API refuses to queue a publish whose review is stale, but a publish
  // can already be queued when a retry regenerates the draft behind it. This
  // site's promise is that every review-branded piece was reviewed, so the
  // last word on that is here, where the push actually happens.
  if (await isReviewStale(article.id)) throw new Error(PUBLISHER_REVIEW_STALE_ERROR);

  // Nothing below this line is an article write the claim guard can drop: it
  // pushes a post to the live site and asks GitHub to rebuild it. So the claim
  // is read directly, where the run can still stop for free. Publish is the
  // stage that hangs on an external service, which is exactly when an operator
  // reaches for cancel - and a cancelled article that is live in D1 with no
  // published_at is the state that lever exists to prevent.
  const abandonIfTaken = async () => {
    if (!(await claimHeld(article))) throw new LeaseLostError();
  };
  await abandonIfTaken();

  const publishMode = options.publishMode ?? (await getSetting<string>('publish_mode', 'approval'));
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
      : todayInSydney());

  // Asked again on the doorstep of the push itself: every affiliate write
  // above is a D1 round trip, and the cancel worth honouring is the one that
  // arrives while one of them is hanging.
  await abandonIfTaken();

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
  //
  // Deviation from the agreed contract, which pins the digest as stored "in
  // the same statement that stamps pub_date": stamping both at once would
  // record a version as delivered before the dispatch that delivers it, so a
  // dispatch that failed would never be retried - the rebuild would be lost
  // with nothing left to say it is owed. The date is stamped here, the digest
  // only after the dispatch has actually been asked for. Raised with the
  // contract owner on SLE-104 rather than settled here: no counterpart card
  // reads published_digest, so the pin can be amended without a re-pin of the
  // payload, but the amendment is theirs to make.
  const digest = publishedDigest(slug, d1Status, frontmatter, body);
  await stamp(article, { pub_date: pubDate });

  const dispatched = d1Status === 'published' && digest !== state.published_digest;
  if (dispatched) await dispatchContentUpdated();
  // Recorded only once the rebuild has actually been asked for, so a failed
  // dispatch is retried by the next pass rather than silently marked as
  // delivered.
  await stamp(article, { published_digest: digest });

  return { slug, d1Status, dispatched };
}
