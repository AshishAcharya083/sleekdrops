// Requalification - put a page that is already live back through the pipeline.
//
// Rebuilding the writing stages does nothing for the articles already on the
// site. The pages an AdSense reviewer flagged were written under the old
// prompts, they are still up, and asking for a second review while they are up
// invites the same answer. Rewriting them by hand does not scale past three.
//
// So the article goes back to the research stage and runs the whole thing
// again - research, keyword, angle, outline, write, review, assemble, image,
// publish - and lands back at the same address. What makes that a rebuild of
// *that page* rather than a new article about the same subject is captured
// here, once, and read back by the three stages that would otherwise lose it:
//
//   slug    the outliner proposes one and is refused; the page keeps its URL,
//           its inbound links and the /go/ rows that hang off it
//   body    the researcher is told what is already published, so it researches
//           the gap rather than re-deriving the same thin dossier
//   pubDate the assembler keeps it and stamps updatedDate alongside, because
//           the page was first published when it was published
//
// Nothing here publishes anything. The run rejoins the normal pipeline at
// 'research/queued' and passes the same approval gate every other article
// does, so a requalification cannot put an unreviewed rewrite on the site.
// The one publish mode it cannot rejoin is 'draft', which would park the
// rebuilt row unpublished and take the live page down with it - that is
// refused here, before the run costs anything.
import { CATEGORIES, goSlugsIn, POST_TYPES } from '../content/contract.js';
import { getSetting, q } from '../db/pool.js';
import { d1Configured, fetchD1Post } from '../tools/d1.js';
import type { ArticleRow, RequalificationSource } from './types.js';

/**
 * Statuses a requalification may interrupt: nothing is mid-flight in any of
 * them. The admin panel mirrors this list (apps/admin/src/api.ts) to decide
 * whether to offer the button; this copy is the one that decides.
 */
export const REQUALIFIABLE_STATUSES = ['done', 'failed', 'timed_out', 'cancelled'];

export type RequalifyOutcome =
  | {
      ok: true;
      articleId: string;
      source: RequalificationSource;
      /** True when the live page had no pipeline article behind it until now. */
      created: boolean;
    }
  | { ok: false; status: 404 | 409 | 503; error: string };

/** The stored frontmatter, or an empty object when the row's JSON is unusable. */
function readFrontmatter(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * What the live page argues, stated as precisely as the platform can manage.
 * The recorded thesis is the best answer, the topic's angle the next, and the
 * published dek the last - a dek is a promise to the reader, which is closer
 * to an angle than the title is.
 */
function existingAngle(
  article: Pick<ArticleRow, 'editorial_angle'> | null,
  topicAngle: string,
  frontmatter: Record<string, unknown>,
): string {
  return (
    str(article?.editorial_angle?.thesis) || topicAngle || str(frontmatter.dek) || ''
  );
}

/**
 * The day the page went up, in the one shape the site's frontmatter schema
 * accepts. The posts table and the stored frontmatter usually agree on a bare
 * YYYY-MM-DD, but a row imported from the old content collection can carry a
 * full timestamp - and a timestamp reaching the assembler fails schema
 * validation at the very end of a full pipeline run. Null when neither source
 * carries a usable date, which leaves the assembler to date the rebuild today.
 */
function publicationDate(
  frontmatter: Record<string, unknown>,
  postPubDate: string | null,
): string | null {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(str(frontmatter.pubDate) || postPubDate || '');
  return match ? match[0] : null;
}

/** The article row already behind this slug, with what a requalification needs off it. */
interface ExistingArticle {
  id: string;
  status: string;
  stage: string;
  editorial_angle: ArticleRow['editorial_angle'];
  topic_angle: string | null;
}

/**
 * Send a published page back to the research stage.
 *
 * Idempotent in the way that matters: a slug whose article is mid-pipeline is
 * refused rather than reset under the stage that is running, and the guard is
 * in the UPDATE's own WHERE clause so two operators clicking at once cannot
 * both win.
 */
export async function requalifyPublished(slug: string): Promise<RequalifyOutcome> {
  if (!d1Configured()) {
    return {
      ok: false,
      status: 503,
      error:
        'Cloudflare D1 is not configured on the agent platform, so there is no live page to requalify - set CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_D1_TOKEN.',
    };
  }

  // Draft mode parks whatever the pipeline finishes in D1 as `status =
  // 'draft'`, and the site build only selects published rows. For a new
  // article that is the whole point of the mode; for a page that is already
  // live it is a deletion - the rebuild lands on the same row, the next build
  // drops the page and a URL people have linked to starts 404ing, with no
  // approval checkpoint anywhere in the run to catch it. So a requalification
  // does not start while the mode is set that way.
  const publishMode = await getSetting<string>('publish_mode', 'approval');
  if (publishMode === 'draft') {
    return {
      ok: false,
      status: 409,
      error:
        `publish mode is "draft", so the rebuild of ${slug} would land in D1 unpublished and take ` +
        'the live page off the site at the next build. Set publish mode to approval (or auto) in ' +
        'Settings first - approval still parks the rebuild for review before anything replaces the page.',
    };
  }

  const post = await fetchD1Post(slug);
  if (!post) return { ok: false, status: 404, error: 'no live post with that slug' };

  // Requalification is for pages that are on the site: it rebuilds the live
  // body and republishes at the same address. A D1 row parked as `draft` is
  // not on the site - the build selects published rows only - and the
  // publisher writes `status = 'published'` for every mode but draft, so
  // finishing this run would put a page that was deliberately withheld in
  // front of readers. The approval gate would ask a human to sign off on a
  // "requalification of a live page" that was never live. Refused here: an
  // unpublished row is a publishing decision, not a rebuild.
  if (post.status !== 'published') {
    return {
      ok: false,
      status: 409,
      error:
        `${slug} is not live - its D1 row is "${post.status}", and the site build only serves ` +
        'published rows. Requalifying rebuilds a page that is already on the site; putting this ' +
        'one up for the first time is a separate decision.',
    };
  }

  const body = post.body_md?.trim() ?? '';
  if (body === '') {
    return {
      ok: false,
      status: 409,
      error: 'the live post carries no body, so there is nothing to requalify from',
    };
  }

  // The site's frontmatter schema takes a category and a post type from fixed
  // lists, and the assembler validates against it. A legacy page filed outside
  // those lists - the old site published `review`, which this pipeline never
  // does - would sail through research, angle, outline, write and up to two
  // review rounds on Opus 5 and only fail at assembly. Refuse it here, where
  // the fix is one D1 field and nothing has been spent.
  const misfiled =
    !(CATEGORIES as readonly string[]).includes(post.category)
      ? { field: 'category', value: post.category, allowed: CATEGORIES }
      : !(POST_TYPES as readonly string[]).includes(post.post_type)
        ? { field: 'post_type', value: post.post_type, allowed: POST_TYPES }
        : null;
  if (misfiled) {
    return {
      ok: false,
      status: 409,
      error:
        `${slug} is filed as ${misfiled.field} "${misfiled.value}", which the pipeline cannot ` +
        `publish - it must be one of: ${misfiled.allowed.join(', ')}. Correct the live post's ` +
        `${misfiled.field} first; the rebuild would otherwise run the whole pipeline and fail at assembly.`,
    };
  }

  const [existing] = await q<ExistingArticle>(
    `SELECT a.id, a.status, a.stage, a.editorial_angle, t.angle topic_angle
       FROM articles a LEFT JOIN topics t ON t.id = a.topic_id
      WHERE a.slug = $1`,
    [slug],
  );
  if (existing && !REQUALIFIABLE_STATUSES.includes(existing.status)) {
    return {
      ok: false,
      status: 409,
      error:
        `${slug} is already in the pipeline at ${existing.stage}/${existing.status}. ` +
        'Let that run finish (or cancel it) before requalifying the page.',
    };
  }

  const frontmatter = readFrontmatter(post.frontmatter_json ?? '');
  const angle = existingAngle(existing ?? null, str(existing?.topic_angle), frontmatter);
  // The assembler reads the publication date off this frontmatter, so it is
  // the one field worth correcting here: a page whose frontmatter lost its
  // pubDate would otherwise be republished as brand new.
  const pubDate = publicationDate(frontmatter, post.pub_date);
  if (pubDate) frontmatter.pubDate = pubDate;
  else delete frontmatter.pubDate;

  const source: RequalificationSource = {
    slug,
    title: post.title,
    angle,
    body,
    pubDate,
    goSlugs: goSlugsIn(body),
    requestedAt: new Date().toISOString(),
  };

  const fields = [
    post.title,
    post.category,
    post.post_type,
    JSON.stringify(frontmatter),
    JSON.stringify(source),
  ];

  if (existing) {
    // Everything the old run derived goes: a dossier, a plan, an angle and a
    // draft written under the prompts that produced the page we are replacing
    // are exactly what must not survive into the rebuild. The frontmatter is
    // the deliberate exception - it is where the publication date and the hero
    // image live, and both are the page's, not the old run's.
    //
    // The rebuild is a new pass, so it takes its own attempt number the way a
    // full re-run does. Nothing stored survives it, so nothing reads as out of
    // date either.
    const reset = await q<{ id: string }>(
      `UPDATE articles
          SET stage = 'research', status = 'queued', revision_round = 0,
              attempt = attempt + 1, stale_from_stage = NULL,
              research = NULL, keyword_plan = NULL, editorial_angle = NULL,
              structure_shape = NULL, outline = NULL, draft_md = NULL,
              seo_review = NULL, feedback = NULL,
              error = NULL, failure_class = NULL, stage_attempts = 0,
              claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
              title = $2, category = $3, post_type = $4,
              frontmatter = $5::jsonb, requalification = $6::jsonb,
              updated_at = now()
        WHERE id = $1 AND status = ANY($7)
        RETURNING id`,
      [existing.id, ...fields, REQUALIFIABLE_STATUSES],
    );
    if (reset.length === 0) {
      return {
        ok: false,
        status: 409,
        error: `${slug} just started running - try again when that stage finishes.`,
      };
    }
    return { ok: true, articleId: reset[0].id, source, created: false };
  }

  // Most of the site predates the agent platform and has no article row at
  // all - which is exactly the corpus the AdSense reviewer read. One is
  // created here so those pages can be requalified too.
  try {
    const [created] = await q<{ id: string }>(
      `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter, requalification)
       VALUES ($2, $1, $3, $4, 'research', 'queued', $5::jsonb, $6::jsonb)
       RETURNING id`,
      [slug, ...fields],
    );
    return { ok: true, articleId: created.id, source, created: true };
  } catch (err) {
    // `articles.slug` is unique, so two operators clicking at once race here.
    // The loser is told to look again rather than handed a 500: the winner's
    // requalification is already queued and a second one would be waste.
    if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
      return {
        ok: false,
        status: 409,
        error: `${slug} was picked up by another requalification a moment ago - reload and check the pipeline board.`,
      };
    }
    throw err;
  }
}
