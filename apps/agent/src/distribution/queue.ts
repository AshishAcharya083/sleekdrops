// The distribution queue: enqueue on publish, claim on a poll, and the retry
// policy in between.
//
// The problem this exists to solve is that publishing is not a single event.
// `runPublisher` is re-entered by POST /api/articles/:id/republish, by a
// retry-from-stage and by the editorial feedback loop, so an inline social
// post would fire again for the same slug every time. Here, publishing writes
// a row, the row is unique on (slug, channel_connection_id), and every later
// pass is an ON CONFLICT DO NOTHING - however many times the stage runs, a
// channel gets one item.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getSetting, q } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import { activeConnections } from './channels.js';
import {
  isLinkPlacement,
  toDistributionItem,
  type DistributableArticle,
  type DistributionItem,
  type DistributionQueueRow,
  type DistributionStatus,
  type HeroImageSource,
  type LinkPlacement,
  type RenderedPayload,
} from './types.js';

const log = createLogger('distribution');

/** How many times an item may be handed to a provider before it is failed. */
export const MAX_POST_ATTEMPTS = 5;

/** First retry delay. Doubles per spent attempt, up to RETRY_CAP_SECONDS. */
export const RETRY_BASE_SECONDS = 60;
export const RETRY_CAP_SECONDS = 3_600;

/**
 * How long a claim may sit in 'posting' before another worker may take it
 * back. Comfortably longer than any single provider call, so a slow network
 * is not mistaken for a dead worker.
 */
export const POSTING_LEASE_SECONDS = 300;

/**
 * Exponential backoff, in seconds, after `attempts` failed attempts.
 * Deterministic and pure so the policy is a unit test rather than a wait.
 */
export function retryDelaySeconds(attempts: number): number {
  const spent = Math.max(1, Math.floor(attempts));
  const delay = RETRY_BASE_SECONDS * 2 ** (spent - 1);
  return Math.min(delay, RETRY_CAP_SECONDS);
}

/** Whether another attempt is owed, or the item is out of them. */
export function retriesExhausted(attempts: number): boolean {
  return attempts >= MAX_POST_ATTEMPTS;
}

/** The canonical, untagged article URL. */
export function articleUrl(slug: string): string {
  return `${config.distribution.siteUrl}/blog/${slug}`;
}

/**
 * The destination as it is posted: UTM-tagged per provider and per placement.
 *
 * The tagging is what lets first-party analytics corroborate the provider's
 * own click count, which matters because the failure mode a network's API
 * cannot report is a comment link that rendered as unclickable plain text -
 * the comment posts fine and returns an id, and the only symptom is referrals
 * that never arrive.
 */
export function taggedUrl(slug: string, provider: string, placement: LinkPlacement): string {
  const url = new URL(articleUrl(slug));
  url.searchParams.set('utm_source', provider);
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', 'distribution');
  url.searchParams.set('utm_content', placement);
  return url.toString();
}

/**
 * What a network's own page must be serving before we point an audience at
 * it. The og:title the site renders carries the site name; the gate compares
 * on the article's own title, which is the part a rebuild changes.
 */
export function expectedOpenGraph(article: DistributableArticle): {
  ogTitle: string;
  ogImage: string | null;
} {
  const frontmatter = article.frontmatter ?? {};
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : article.title;
  const heroImage = typeof frontmatter.heroImage === 'string' ? frontmatter.heroImage : null;
  return { ogTitle: title, ogImage: heroImage };
}

/**
 * The hero, and whether this account may upload it.
 *
 * Only an image we generated may be uploaded natively: a native upload grants
 * the network a sublicensable licence in the file, and that is not ours to
 * grant in a photograph the image agent found on someone else's site. A
 * 'found' or 'operator' hero therefore arrives as a provenance with no URL,
 * and it is the provider's ladder - render a social card, or fall back to a
 * placement that earns the link preview - that decides what to do about it.
 */
function uploadableImage(article: DistributableArticle): {
  imageUrl: string | null;
  imageSource: HeroImageSource | null;
} {
  const frontmatter = article.frontmatter ?? {};
  const heroImage = typeof frontmatter.heroImage === 'string' ? frontmatter.heroImage : null;
  const imageSource = article.hero_image_source;
  return {
    imageUrl: imageSource === 'generated' ? heroImage : null,
    imageSource: heroImage ? imageSource : null,
  };
}

/**
 * The baseline post for an article, network-agnostic: the headline, the dek
 * and the destination. A provider's own renderer composes the caption it
 * actually needs (the link cue, the affiliate disclosure, the house blocks)
 * and writes it back onto the row; this is what an adapter that does none of
 * that would still be able to post.
 */
export function renderPayload(
  article: DistributableArticle,
  provider: string,
  placement: LinkPlacement,
): RenderedPayload {
  const slug = article.slug!;
  const frontmatter = article.frontmatter ?? {};
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : article.title;
  const dek = typeof frontmatter.dek === 'string' ? frontmatter.dek : '';
  const url = taggedUrl(slug, provider, placement);
  const caption = [title, dek, placement === 'in_body' ? url : '']
    .filter((line) => line !== '')
    .join('\n\n');
  return {
    caption,
    url,
    placement,
    commentText: url,
    ...uploadableImage(article),
    expected: expectedOpenGraph(article),
  };
}

/** What one publish pass did to the queue. */
export interface EnqueueOutcome {
  created: number;
  alreadyQueued: number;
  /** Why nothing was queued, when nothing was. */
  skipped: 'draft' | 'no-slug' | 'no-channels' | 'disabled' | null;
}

export interface EnqueueOptions {
  /**
   * What the publisher actually pushed. A draft is not on the site, so there
   * is nothing for a reader to be sent to - the same guard
   * `dispatchContentUpdated` is behind, read off the same value.
   */
  d1Status: 'published' | 'draft';
}

/**
 * Queue one item per connected channel for a published article.
 *
 * Idempotent by the unique index, not by a read-then-write: two publish passes
 * racing each other both run the INSERT and exactly one of them creates a row.
 */
export async function enqueuePublishedArticle(
  article: DistributableArticle,
  options: EnqueueOptions,
): Promise<EnqueueOutcome> {
  const none: EnqueueOutcome = { created: 0, alreadyQueued: 0, skipped: null };
  if (options.d1Status !== 'published') return { ...none, skipped: 'draft' };
  if (!article.slug) return { ...none, skipped: 'no-slug' };
  if (!(await getSetting<boolean>('distribution_enabled', true))) {
    return { ...none, skipped: 'disabled' };
  }

  const connections = await activeConnections();
  if (connections.length === 0) return { ...none, skipped: 'no-channels' };

  const configured = await getSetting<string>('distribution_link_placement', 'first_comment');
  const placement: LinkPlacement = isLinkPlacement(configured) ? configured : 'first_comment';

  let created = 0;
  let disconnected = 0;
  for (const connection of connections) {
    const payload = renderPayload(article, connection.provider, placement);
    let rows: Array<{ id: string }>;
    try {
      rows = await q<{ id: string }>(
        `INSERT INTO distribution_queue
           (article_id, slug, channel_connection_id, provider, payload, placement)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (slug, channel_connection_id) DO NOTHING
         RETURNING id`,
        [
          article.id,
          article.slug,
          connection.id,
          connection.provider,
          JSON.stringify(payload),
          placement,
        ],
      );
    } catch (err) {
      // 23503: the channel was disconnected between the read above and this
      // insert. The post is already live on the site, so losing a channel
      // nobody is connected to any more must not fail the publish stage - the
      // remaining channels still get their item.
      if ((err as { code?: string } | null)?.code !== '23503') throw err;
      disconnected += 1;
      log.warn('channel disconnected mid-publish; nothing queued for it', {
        article_id: article.id,
        slug: article.slug,
        channel_connection_id: connection.id,
      });
      continue;
    }
    if (rows.length === 0) continue;
    created += 1;
    log.info('queued for distribution', {
      article_id: article.id,
      slug: article.slug,
      provider: connection.provider,
      channel_connection_id: connection.id,
      placement,
      queue_item_id: rows[0].id,
    });
  }
  return {
    created,
    alreadyQueued: connections.length - created - disconnected,
    skipped: null,
  };
}

/** A one-line summary of an enqueue, for the publish stage's session row. */
export function describeEnqueue(outcome: EnqueueOutcome): string {
  switch (outcome.skipped) {
    case 'draft':
      return 'not distributed (draft)';
    case 'no-slug':
      return 'not distributed (no slug)';
    case 'no-channels':
      return 'no channels connected';
    case 'disabled':
      return 'distribution disabled';
    default:
      break;
  }
  const already =
    outcome.alreadyQueued > 0 ? `, ${outcome.alreadyQueued} already queued` : '';
  return `queued for ${outcome.created} channel(s)${already}`;
}

/**
 * Take the next due item for a provider we actually have an adapter for, on a
 * connection that can still post.
 *
 * `attempts` is untouched: it counts provider calls, and an item claimed while
 * the site is still rebuilding has not made one. It is spent by
 * `startPostAttempt`, immediately before the call itself.
 */
export async function claimNextItem(providers: string[]): Promise<DistributionItem | null> {
  if (providers.length === 0) return null;
  const rows = await q<DistributionQueueRow>(
    `UPDATE distribution_queue d
     SET status = 'posting', claimed_by = $2, claimed_at = now(), updated_at = now()
     WHERE d.id = (
       SELECT item.id FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
       WHERE item.status = 'pending'
         AND item.scheduled_at <= now()
         AND item.provider = ANY($1)
         AND channel.status = 'active'
         AND (channel.expires_at IS NULL OR channel.expires_at > now())
       ORDER BY item.scheduled_at ASC
       LIMIT 1
       FOR UPDATE OF item SKIP LOCKED
     )
     RETURNING *`,
    [providers, `distribution-${randomUUID().slice(0, 8)}`],
  );
  return rows[0] ? toDistributionItem(rows[0]) : null;
}

/**
 * Mark that this item has now been checked against the live page at least
 * once, and return when that clock started. The readiness window runs from
 * here rather than from `created_at` so an item queued while the worker was
 * down still gets the full rebuild wait when the worker comes back.
 */
export async function startReadinessClock(id: string): Promise<string> {
  const [row] = await q<{ readiness_started_at: string }>(
    `UPDATE distribution_queue
     SET readiness_started_at = COALESCE(readiness_started_at, now()), updated_at = now()
     WHERE id = $1
     RETURNING readiness_started_at`,
    [id],
  );
  return row.readiness_started_at;
}

/** Put a claimed item back in the queue, due again at `delaySeconds`. */
export async function releaseItem(
  id: string,
  delaySeconds: number,
  lastError: string | null,
): Promise<void> {
  await q(
    `UPDATE distribution_queue
     SET status = 'pending', scheduled_at = now() + make_interval(secs => $2),
         last_error = $3, claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE id = $1`,
    [id, delaySeconds, lastError],
  );
}

/**
 * Spend one attempt, immediately before the provider call it pays for.
 *
 * The readiness clock is cleared with it, so the rebuild window is per post
 * round rather than per item: a page that was live when this attempt started
 * and is answering 502 by the time the backoff expires is a fresh wait, not
 * the original one running out. Without this, a retry hours later would be
 * failed as "the gate never opened" the moment it found the site unwell.
 */
export async function startPostAttempt(id: string): Promise<number> {
  const [row] = await q<{ attempts: number }>(
    `UPDATE distribution_queue
     SET attempts = attempts + 1, readiness_started_at = NULL, updated_at = now()
     WHERE id = $1 RETURNING attempts`,
    [id],
  );
  return row.attempts;
}

export async function markPosted(id: string, remotePostId: string, note?: string): Promise<void> {
  await q(
    `UPDATE distribution_queue
     SET status = 'posted', remote_post_id = $2, posted_at = now(), last_error = $3,
         claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE id = $1`,
    [id, remotePostId, note ?? null],
  );
}

/** Terminal. Nothing re-queues an item from here except an operator. */
export async function markFailed(id: string, error: string): Promise<void> {
  await q(
    `UPDATE distribution_queue
     SET status = 'failed', last_error = $2, claimed_by = NULL, claimed_at = NULL,
         updated_at = now()
     WHERE id = $1`,
    [id, error],
  );
}

/**
 * Return items stranded in 'posting' by a worker that died mid-claim.
 *
 * Only an item with no `remote_post_id` is taken back, and its attempt is
 * already spent (`startPostAttempt` runs before the call), so recovery cannot
 * double-count. A post that landed on the network after the worker died but
 * before it could record the id would be sent twice - which is why the attempt
 * is spent first and the lease is long: the item runs out of attempts rather
 * than looping, and a duplicate needs both a lost worker and a call that
 * succeeded in the gap.
 */
export async function recoverStrandedItems(): Promise<number> {
  const rows = await q<{ id: string }>(
    `UPDATE distribution_queue
     SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
         scheduled_at = now() + make_interval(secs => $3),
         last_error = 'worker stopped mid-post; the attempt was already spent',
         claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE status = 'posting'
       AND remote_post_id IS NULL
       AND claimed_at < now() - make_interval(secs => $1)
     RETURNING id`,
    [POSTING_LEASE_SECONDS, MAX_POST_ATTEMPTS, RETRY_BASE_SECONDS],
  );
  if (rows.length > 0) log.warn('recovered stranded distribution items', { items: rows.length });
  return rows.length;
}

export async function getItem(id: string): Promise<DistributionItem | null> {
  const [row] = await q<DistributionQueueRow>('SELECT * FROM distribution_queue WHERE id = $1', [
    id,
  ]);
  return row ? toDistributionItem(row) : null;
}

/** The queue for one article, newest first. */
export async function itemsForArticle(articleId: string): Promise<DistributionItem[]> {
  const rows = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE article_id = $1 ORDER BY created_at DESC',
    [articleId],
  );
  return rows.map(toDistributionItem);
}

/**
 * How many items sit in each state - the panel's headline figures. Every state
 * is present even at zero, so the panel renders a stable set of tiles instead
 * of one that appears when the first item fails.
 */
export async function queueCounts(): Promise<Record<DistributionStatus, number>> {
  const counts: Record<DistributionStatus, number> = {
    pending: 0,
    posting: 0,
    posted: 0,
    failed: 0,
    held: 0,
  };
  const rows = await q<{ status: DistributionStatus; n: string }>(
    'SELECT status, count(*) n FROM distribution_queue GROUP BY status',
  );
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}

export async function recentItems(limit = 50): Promise<DistributionItem[]> {
  const rows = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(toDistributionItem);
}

/** Record one aggregate insights reading against a posted item. */
export async function recordMetrics(
  queueItemId: string,
  metrics: { impressions: number | null; clicks: number | null; reactions: number | null },
): Promise<void> {
  await q(
    `INSERT INTO distribution_metrics (queue_item_id, impressions, clicks, reactions)
     VALUES ($1, $2, $3, $4)`,
    [queueItemId, metrics.impressions, metrics.clicks, metrics.reactions],
  );
}
