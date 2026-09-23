// Post insights: the scheduled read-back that turns a posted item into
// numbers, and the one conclusion those numbers can reach on their own.
//
// Why this exists at all. The first_comment default rests on industry
// reporting with no published demotion multiplier, and on a small practitioner
// sample suggesting a meaningful share of comment links render as unclickable
// plain text. Neither is a number for Sleekdrops, and the second failure is
// invisible from the API side: the comment posts successfully and returns an
// id, so the adapter has nothing to report. The only symptom is impressions
// accumulating against clicks that never arrive - which is a thing this job
// can see and the posting worker cannot.
//
// Four properties it is shaped by:
//
//   * A post's counters move fastest in the hours after it lands and barely at
//     all after a week, so the cadence widens (INSIGHT_CHECKPOINT_SECONDS) and
//     then stops. Nothing polls a cold post for ever.
//   * Placement is read off the queue row, never copied onto the reading. The
//     row is where a placement resolved at render time is recorded, so the
//     join is the only version of the truth that stays correct.
//   * The counters are lifetime totals, and a reading the network answered
//     with nothing is stored as the NULLs it came back as. So both the flag
//     and the placement comparison are judged on the highest each counter has
//     reached rather than on the latest row: one empty or partial /insights
//     response cannot erase a post's numbers or withdraw a conclusion.
//   * It must not be able to block posting. It is its own interval with its
//     own tick, and a fetch that throws is logged, left off the queue row's
//     `last_error` (that column is the panel's account of the *post*), and
//     retried at the next poll until the collection window closes.
//
// What is stored stays aggregate: impressions, clicks, reactions. No commenter
// identity, no comment text, no demographic or audience breakdown - see the
// distribution_metrics comment in 014_distribution.sql.
import { config } from '../config.js';
import { getSetting, q } from '../db/pool.js';
import { createLogger } from '../lib/log.js';
import { getConnection, redactToken, resolveCredential } from './channels.js';
import { getProvider, registeredProviders } from './providers.js';
import { recordMetrics } from './queue.js';
import {
  toDistributionItem,
  UNCLICKABLE_COMMENT_LINK,
  type DistributionItem,
  type DistributionQueueRow,
  type InsightSnapshot,
  type InsightsFlag,
  type LinkPlacement,
  type SocialProvider,
} from './types.js';

const log = createLogger('distribution');

/**
 * When a reading is taken, as seconds after the post landed: an hour, six, a
 * day, three days, a week. Widening rather than fixed because the first hours
 * are where an impression count separates a post that reached people from one
 * that did not, and the seventh day is where it has stopped moving.
 */
export const INSIGHT_CHECKPOINT_SECONDS: readonly number[] = [
  3_600,
  6 * 3_600,
  24 * 3_600,
  3 * 24 * 3_600,
  7 * 24 * 3_600,
];

/**
 * The hard end of the collection window. A day past the last checkpoint, so a
 * network that was refusing calls at the seven-day mark still has room for the
 * retries that get the final reading - and so nothing polls for ever whatever
 * state a row is left in.
 */
export const INSIGHT_WINDOW_SECONDS = 8 * 24 * 3_600;

/** How long a failed reading waits before it is tried again. */
export const INSIGHT_RETRY_SECONDS = 900;

/**
 * How long a claimed item is held before another process may take it. Only
 * ever shortens the wait on a crash: success or failure overwrites it.
 */
const INSIGHT_LEASE_SECONDS = 300;

/** Items one tick will read, so a launch-day batch cannot monopolise a poll. */
const MAX_ITEMS_PER_TICK = 10;

/**
 * Impressions a post must have accumulated before its click count means
 * anything. Below this, zero clicks is an ordinary quiet post rather than
 * evidence of a link nobody could click.
 */
export const UNCLICKABLE_MIN_IMPRESSIONS = 200;

/**
 * Clicks per impression beneath which a first-comment post looks broken.
 *
 * Deliberately far under any plausible click-through rate: the counter a
 * network reports is every click on the post (a photo expanded, a "see more"),
 * so it is a generous superset of link clicks. A post that reached hundreds of
 * people and recorded almost nothing of that superset did not have a link
 * anyone could follow.
 */
export const UNCLICKABLE_CLICK_RATE = 0.002;

/** What the flag is decided from: the counters, and the placement they belong to. */
export interface PlacementReading {
  placement: LinkPlacement;
  impressions: number | null;
  clicks: number | null;
}

/**
 * What this post's counters conclude, or null for nothing to report.
 *
 * Pure, and judged on everything the network has reported so far rather than
 * on one reading in isolation (see `reportedCounters`): a post whose clicks
 * arrive late clears its own flag at the next checkpoint. Only first_comment
 * can be flagged - an in_body post carries its link in the caption, where
 * there is no rendering failure of this kind to detect.
 *
 * A counter the network did not report (null) is not evidence of anything, and
 * neither is a post too quiet to judge, so both leave `current` - what an
 * earlier reading concluded - standing. Nothing but evidence clears a flag;
 * silence from the network is not "clicks are arriving".
 */
export function insightsFlag(
  reading: PlacementReading,
  current: InsightsFlag | null = null,
): InsightsFlag | null {
  if (reading.placement !== 'first_comment') return null;
  const { impressions, clicks } = reading;
  if (impressions === null || clicks === null) return current;
  if (impressions < UNCLICKABLE_MIN_IMPRESSIONS) return current;
  return clicks / impressions < UNCLICKABLE_CLICK_RATE ? UNCLICKABLE_COMMENT_LINK : null;
}

/**
 * The next checkpoint strictly after `now`, or null once the schedule is
 * spent.
 *
 * Expressed as "the first checkpoint still in the future" rather than "the
 * next one along" so that an item whose readings started late - a post that
 * landed while this job was down, or the first pass over posts that predate it
 * - catches up in one reading instead of firing every missed checkpoint back
 * to back for the same unchanging numbers.
 */
export function nextInsightsPollAt(postedAt: Date, now: Date): Date | null {
  for (const seconds of INSIGHT_CHECKPOINT_SECONDS) {
    const at = new Date(postedAt.getTime() + seconds * 1_000);
    if (at > now) return at;
  }
  return null;
}

/** When to try again after a failed reading, or null once the window is shut. */
export function retryInsightsPollAt(postedAt: Date, now: Date): Date | null {
  const at = new Date(now.getTime() + INSIGHT_RETRY_SECONDS * 1_000);
  const windowEnds = postedAt.getTime() + INSIGHT_WINDOW_SECONDS * 1_000;
  return at.getTime() <= windowEnds ? at : null;
}

/**
 * Take up to `limit` posted items whose next reading is due.
 *
 * Leased the way the posting worker claims: `insights_next_at` is pushed out
 * before the row is returned, under SKIP LOCKED, so two processes polling at
 * once cannot both read the same post. The connection filter matches the
 * worker's - a lapsed token cannot fetch insights either - and `updated_at` is
 * deliberately untouched, because the panel orders the queue by it and a
 * background reading is not activity on the post.
 */
export async function claimDueInsights(
  providers: string[],
  limit = MAX_ITEMS_PER_TICK,
): Promise<DistributionItem[]> {
  if (providers.length === 0) return [];
  const rows = await q<DistributionQueueRow>(
    `UPDATE distribution_queue d
     SET insights_next_at = now() + make_interval(secs => $4)
     WHERE d.id IN (
       SELECT item.id FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
       WHERE item.status = 'posted'
         AND NOT item.insights_done
         AND item.remote_post_id IS NOT NULL
         AND item.posted_at IS NOT NULL
         AND item.posted_at > now() - make_interval(secs => $2)
         AND COALESCE(item.insights_next_at, item.posted_at + make_interval(secs => $3)) <= now()
         AND item.provider = ANY($1)
         AND channel.status = 'active'
         AND (channel.expires_at IS NULL OR channel.expires_at > now())
       ORDER BY item.posted_at ASC
       LIMIT $5
       FOR UPDATE OF item SKIP LOCKED
     )
     RETURNING d.*`,
    [providers, INSIGHT_WINDOW_SECONDS, INSIGHT_CHECKPOINT_SECONDS[0], INSIGHT_LEASE_SECONDS, limit],
  );
  return rows.map(toDistributionItem);
}

/**
 * Move the clock on, and record what the reading concluded.
 *
 * A null `at` is the end of the schedule, not the start of it: `insights_done`
 * is what stops the claim, because a null clock on its own reads as "never
 * scheduled" and would put the post straight back in the queue.
 */
async function scheduleNextPoll(
  id: string,
  at: Date | null,
  flag: InsightsFlag | null,
): Promise<void> {
  await q(
    `UPDATE distribution_queue
     SET insights_next_at = $2, insights_done = ($2::timestamptz IS NULL), insights_flag = $3
     WHERE id = $1`,
    [id, at, flag],
  );
}

/**
 * Everything the network has reported for this post, as one set of counters.
 *
 * The counters are lifetime totals, so the highest value each has reached is
 * the current one - and taking that per counter rather than per reading is
 * what keeps a response that reported nothing (an empty or partial /insights
 * answer, stored as the NULLs it was) from losing what an earlier reading
 * reported. NULL here means no reading has ever carried that counter.
 */
async function reportedCounters(
  queueItemId: string,
): Promise<{ impressions: number | null; clicks: number | null }> {
  const [row] = await q<{ impressions: number | null; clicks: number | null }>(
    `SELECT max(impressions) AS impressions, max(clicks) AS clicks
     FROM distribution_metrics
     WHERE queue_item_id = $1`,
    [queueItemId],
  );
  return row ?? { impressions: null, clicks: null };
}

/** What one item's reading did. */
export type InsightOutcome = 'recorded' | 'flagged' | 'unavailable' | 'failed';

/** Everything the loop touches that a test needs to stand in for. */
export interface InsightsDeps {
  now?: () => Date;
  resolveProvider?: (name: string) => SocialProvider | null;
  availableProviders?: () => string[];
}

/**
 * Read one posted item back and store what the network reported.
 *
 * The placement the flag is judged against comes off the queue row rather than
 * off the payload, because the row is what a renderer that resolved a
 * placement wrote to, and what the comparison across placements later groups
 * by. A provider that throws is answered here rather than propagated: one
 * network refusing to report is not the rest of the batch's problem.
 */
export async function collectItemInsights(
  item: DistributionItem,
  deps: InsightsDeps = {},
): Promise<InsightOutcome> {
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? getProvider;
  const postedAt = new Date(item.postedAt!);

  const provider = resolveProvider(item.provider);
  const connection = provider ? await getConnection(item.channelConnectionId) : null;
  const accessToken = connection ? await resolveCredential(connection.token_ref) : null;
  if (!provider || !connection || !accessToken) {
    // Nothing to read this post with. Not a failure of the network and not
    // something a reading can fix, so it waits out the same retry the
    // posting worker's own credential gap waits out - the operator action
    // that fixes one fixes both.
    await scheduleNextPoll(item.id, retryInsightsPollAt(postedAt, now()), item.insightsFlag);
    log.warn('post insights unavailable', {
      queue_item_id: item.id,
      slug: item.slug,
      provider: item.provider,
      reason: !provider
        ? 'no adapter registered'
        : !connection
          ? 'the channel connection is gone'
          : `no credential found for ${connection.token_ref}`,
    });
    return 'unavailable';
  }

  let snapshot: InsightSnapshot;
  try {
    snapshot = await provider.fetchInsights({
      accessToken,
      externalAccountId: connection.external_account_id,
      remotePostId: item.remotePostId!,
    });
  } catch (err) {
    // Logged, never written to the row: `last_error` is the panel's account of
    // what happened to the *post*, and a failed reading did not change that.
    const message = redactToken(err instanceof Error ? err.message : String(err), accessToken);
    await scheduleNextPoll(item.id, retryInsightsPollAt(postedAt, now()), item.insightsFlag);
    log.warn('post insights fetch failed, will retry', {
      queue_item_id: item.id,
      slug: item.slug,
      provider: item.provider,
      retry_in_seconds: INSIGHT_RETRY_SECONDS,
      error: message,
    });
    return 'failed';
  }

  await recordMetrics(item.id, snapshot);
  // Judged on every counter the network has ever reported for this post, not
  // on the snapshot alone: a /insights response that came back empty or partial
  // must not read as "this post has no clicks".
  const counters = await reportedCounters(item.id);
  const flag = insightsFlag({ placement: item.placement, ...counters }, item.insightsFlag);
  await scheduleNextPoll(item.id, nextInsightsPollAt(postedAt, now()), flag);

  log.info('post insights recorded', {
    queue_item_id: item.id,
    slug: item.slug,
    provider: item.provider,
    placement: item.placement,
    impressions: snapshot.impressions,
    clicks: snapshot.clicks,
    reactions: snapshot.reactions,
  });
  if (flag) {
    log.warn('first-comment link may not be clickable', {
      queue_item_id: item.id,
      slug: item.slug,
      provider: item.provider,
      remote_post_id: item.remotePostId,
      impressions: snapshot.impressions,
      clicks: snapshot.clicks,
      flag,
    });
  }
  return flag ? 'flagged' : 'recorded';
}

/** One poll: read back every posted item whose next checkpoint has arrived. */
export async function insightsTick(deps: InsightsDeps = {}): Promise<InsightOutcome[]> {
  // The same switch that stops the posting worker. An operator who turns
  // distribution off means "make no calls to these networks as this Page";
  // readings resume on their own if it is back on inside the item's window.
  if (!(await getSetting<boolean>('distribution_enabled', true))) return [];

  const providers = (deps.availableProviders ?? registeredProviders)();
  const items = await claimDueInsights(providers);
  const outcomes: InsightOutcome[] = [];
  for (const item of items) {
    try {
      outcomes.push(await collectItemInsights(item, deps));
    } catch (err) {
      // collectItemInsights handles a provider that throws; reaching here means
      // the database did, and one unreadable row must not cost the rest of the
      // batch its reading. The lease the claim took expires on its own.
      outcomes.push('failed');
      log.error('post insights reading could not be completed', {
        queue_item_id: item.id,
        slug: item.slug,
        provider: item.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

export function startInsightsCollector(): void {
  // Same shape as the posting worker: one tick at a time, so a slow network
  // cannot have two polls claiming overlapping work.
  let ticking = false;
  const interval = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void insightsTick()
      .catch((err) => console.error('[distribution] insights tick failed:', err))
      .finally(() => {
        ticking = false;
      });
  }, config.distribution.insightsPollMs);
  interval.unref();
  console.log(
    `[distribution] post insights polling every ${config.distribution.insightsPollMs}ms ` +
      `(checkpoints at ${INSIGHT_CHECKPOINT_SECONDS.map((s) => `${s / 3_600}h`).join(', ')} after a post)`,
  );
}

/** How one placement is doing, across every post that used it. */
export interface PlacementPerformance {
  placement: LinkPlacement;
  /**
   * Posts this placement has numbers for. One the network has never reported a
   * counter for is not among them: it is not evidence either way, and counting
   * it would drag the placement's apparent click rate towards zero.
   */
  posts: number;
  impressions: number;
  clicks: number;
  reactions: number;
  /** Posts whose counters look like a link nobody could click. */
  flagged: number;
}

/**
 * The comparison this whole job exists to make possible: what each placement
 * actually earned.
 *
 * One contribution per post, not the sum of its readings - a network reports
 * lifetime counters, so adding two checkpoints of the same post would count it
 * twice. That contribution is the highest each counter has reached, taken per
 * counter rather than per reading, because a response that reported nothing is
 * stored as the NULLs it was: reading the latest row alone would let one empty
 * answer erase a post's real impressions and clicks while still counting the
 * post. Placement is joined from the queue row, which is where a placement
 * resolved at render time was recorded.
 */
export async function placementPerformance(): Promise<PlacementPerformance[]> {
  return q<PlacementPerformance>(
    `SELECT item.placement,
            count(*)::int AS posts,
            COALESCE(sum(reported.impressions), 0)::int AS impressions,
            COALESCE(sum(reported.clicks), 0)::int AS clicks,
            COALESCE(sum(reported.reactions), 0)::int AS reactions,
            count(*) FILTER (WHERE item.insights_flag IS NOT NULL)::int AS flagged
     FROM distribution_queue item
     JOIN LATERAL (
       SELECT max(m.impressions) AS impressions,
              max(m.clicks) AS clicks,
              max(m.reactions) AS reactions
       FROM distribution_metrics m
       WHERE m.queue_item_id = item.id
     ) reported
       ON reported.impressions IS NOT NULL
       OR reported.clicks IS NOT NULL
       OR reported.reactions IS NOT NULL
     GROUP BY item.placement
     ORDER BY item.placement`,
  );
}
