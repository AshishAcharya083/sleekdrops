/**
 * Which rows a request's platform may see. A row of another platform answers
 * exactly like a row that does not exist, so ids from one brand can never be
 * used to read or steer another's.
 *
 * Distribution rows carry no platform of their own: an item belongs to the
 * platform of the channel it posts to.
 */
import { q } from '../db/pool.js';
import { isUuid } from '../distribution/admin.js';
import type { PlacementPerformance } from '../distribution/insights.js';
import {
  toDistributionItem,
  type DistributionItem,
  type DistributionQueueRow,
  type DistributionStatus,
} from '../distribution/types.js';

async function exists(sql: string, params: unknown[]): Promise<boolean> {
  return (await q(sql, params)).length > 0;
}

export function articleBelongs(platformId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return Promise.resolve(false);
  return exists('SELECT 1 FROM articles WHERE id = $1 AND platform_id = $2', [id, platformId]);
}

export function topicBelongs(platformId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return Promise.resolve(false);
  return exists('SELECT 1 FROM topics WHERE id = $1 AND platform_id = $2', [id, platformId]);
}

export function channelBelongs(platformId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return Promise.resolve(false);
  return exists('SELECT 1 FROM channel_connections WHERE id = $1 AND platform_id = $2', [
    id,
    platformId,
  ]);
}

/** The platform an account is already connected under, or null when it is not connected. */
export async function channelAccountOwner(
  provider: string,
  externalAccountId: string,
): Promise<string | null> {
  const [row] = await q<{ platform_id: string }>(
    'SELECT platform_id FROM channel_connections WHERE provider = $1 AND external_account_id = $2',
    [provider, externalAccountId],
  );
  return row?.platform_id ?? null;
}

/** The ids of the platform's channels. */
export async function platformChannelIds(platformId: string): Promise<Set<string>> {
  const rows = await q<{ id: string }>('SELECT id FROM channel_connections WHERE platform_id = $1', [
    platformId,
  ]);
  return new Set(rows.map((row) => row.id));
}

/** The networks the platform has a channel on, connected or not. */
export async function platformProviders(platformId: string): Promise<string[]> {
  const rows = await q<{ provider: string }>(
    'SELECT DISTINCT provider FROM channel_connections WHERE platform_id = $1',
    [platformId],
  );
  return rows.map((row) => row.provider);
}

/** The subset of `ids` that are queue items on the platform's channels. */
export async function platformQueueItemIds(platformId: string, ids: string[]): Promise<Set<string>> {
  const valid = [...new Set(ids.filter(isUuid))];
  if (valid.length === 0) return new Set();
  const rows = await q<{ id: string }>(
    `SELECT item.id FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
      WHERE item.id = ANY($1::uuid[]) AND channel.platform_id = $2`,
    [valid, platformId],
  );
  return new Set(rows.map((row) => row.id));
}

export async function queueItemBelongs(platformId: string, id: string): Promise<boolean> {
  return (await platformQueueItemIds(platformId, [id])).has(id);
}

/** distribution/queue.ts queueCounts(), for one platform's channels. */
export async function platformQueueCounts(
  platformId: string,
): Promise<Record<DistributionStatus, number>> {
  const counts: Record<DistributionStatus, number> = {
    pending: 0,
    posting: 0,
    posted: 0,
    failed: 0,
    held: 0,
  };
  const rows = await q<{ status: DistributionStatus; n: string }>(
    `SELECT item.status, count(*) n FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
      WHERE channel.platform_id = $1
      GROUP BY item.status`,
    [platformId],
  );
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}

/** distribution/queue.ts recentItems(), for one platform's channels. */
export async function platformRecentItems(
  platformId: string,
  limit: number,
): Promise<DistributionItem[]> {
  const rows = await q<DistributionQueueRow>(
    `SELECT item.* FROM distribution_queue item
       JOIN channel_connections channel ON channel.id = item.channel_connection_id
      WHERE channel.platform_id = $1
      ORDER BY item.updated_at DESC LIMIT $2`,
    [platformId, limit],
  );
  return rows.map(toDistributionItem);
}

/**
 * distribution/insights.ts placementPerformance(), for one platform's
 * channels: one contribution per post, the highest each counter reached.
 */
export async function platformPlacementPerformance(
  platformId: string,
): Promise<PlacementPerformance[]> {
  return q<PlacementPerformance>(
    `SELECT item.placement,
            count(*)::int AS posts,
            COALESCE(sum(reported.impressions), 0)::int AS impressions,
            COALESCE(sum(reported.clicks), 0)::int AS clicks,
            COALESCE(sum(reported.reactions), 0)::int AS reactions,
            count(*) FILTER (WHERE item.insights_flag IS NOT NULL)::int AS flagged
     FROM distribution_queue item
     JOIN channel_connections channel ON channel.id = item.channel_connection_id
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
     WHERE channel.platform_id = $1
     GROUP BY item.placement
     ORDER BY item.placement`,
    [platformId],
  );
}
