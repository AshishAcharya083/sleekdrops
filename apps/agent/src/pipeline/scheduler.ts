// Autonomous topic scouting — every platform researches new topics on its own
// on its own settings-driven interval; humans still pick which ones get written
// (and approve publishes, unless publish_mode is switched to auto). A paused
// platform (worker_enabled off) schedules nothing, and no platform's backlog,
// cadence or last run holds another back.
import { getSetting, q } from '../db/pool.js';
import type { Platform } from '../platform/types.js';
import { activePlatforms } from './platforms.js';
import { enqueueScoutRun, hasPendingScoutRuns, recoverStaleScoutRuns } from './scout.js';

// Don't pile up suggestions nobody has triaged yet. Counted per platform, since
// each platform's suggestions are triaged on their own; a platform's
// `max_pending_suggestions` setting overrides it.
const MAX_PENDING_SUGGESTIONS = 30;

/**
 * Queue one topic search per edition of this platform when its scout is due.
 * Returns the queued run ids, empty when it was not due.
 */
export async function scheduleScout(platform: Platform, now: Date = new Date()): Promise<string[]> {
  const hours = await getSetting<number>(platform.id, 'scout_interval_hours', 24);
  if (!hours || hours <= 0) return [];
  if (await hasPendingScoutRuns(platform.id)) return [];

  const [pending] = await q<{ n: string }>(
    "SELECT count(*) n FROM topics WHERE platform_id = $1 AND status = 'suggested'",
    [platform.id],
  );
  const limit = await getSetting<number>(platform.id, 'max_pending_suggestions', MAX_PENDING_SUGGESTIONS);
  if (Number(pending.n) >= limit) return [];

  const [last] = await q<{ started_at: string }>(
    'SELECT started_at FROM scout_runs WHERE platform_id = $1 ORDER BY started_at DESC LIMIT 1',
    [platform.id],
  );
  if (last && now.getTime() - new Date(last.started_at).getTime() < hours * 3_600_000) return [];

  console.log(`[scheduler] ${platform.id} scout due (every ${hours}h) — queueing topic search`);
  const queued: string[] = [];
  for (const edition of platform.editions) {
    queued.push(await enqueueScoutRun(platform.id, edition.id));
  }
  return queued;
}

async function tick(): Promise<void> {
  // A killed worker's request goes back onto the same durable queue.
  await recoverStaleScoutRuns();

  for (const platform of await activePlatforms()) {
    // One platform's failure (a bad setting, a missing edition) must not stop
    // the others from being scheduled.
    await scheduleScout(platform).catch((err) =>
      console.error(`[scheduler] ${platform.id} tick failed:`, err),
    );
  }
}

export function startScheduler(): void {
  const interval = setInterval(() => {
    void tick().catch((err) => console.error('[scheduler] tick failed:', err));
  }, 60_000);
  interval.unref();
  console.log('[scheduler] autonomous topic scout active per platform (interval set in admin Settings)');
}
