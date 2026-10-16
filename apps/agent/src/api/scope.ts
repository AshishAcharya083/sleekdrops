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
