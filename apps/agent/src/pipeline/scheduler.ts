// Autonomous topic scouting — the platform researches new topics on its own
// on a settings-driven interval; humans still pick which ones get written
// (and approve publishes, unless publish_mode is switched to auto).
import { getSetting, q } from '../db/pool.js';
import { isScoutRunning, startScoutRun } from './scout.js';

// Don't pile up suggestions nobody has triaged yet.
const MAX_PENDING_SUGGESTIONS = 30;

async function tick(): Promise<void> {
  const hours = await getSetting<number>('scout_interval_hours', 24);
  if (!hours || hours <= 0) return;
  if (await isScoutRunning()) return;

  const [pending] = await q<{ n: string }>(
    "SELECT count(*) n FROM topics WHERE status = 'suggested'",
  );
  if (Number(pending.n) >= MAX_PENDING_SUGGESTIONS) return;

  const [last] = await q<{ started_at: string }>(
    'SELECT started_at FROM scout_runs ORDER BY started_at DESC LIMIT 1',
  );
  if (last && Date.now() - new Date(last.started_at).getTime() < hours * 3_600_000) return;

  console.log(`[scheduler] scout due (every ${hours}h) — starting sweep`);
  await startScoutRun();
}

export function startScheduler(): void {
  const interval = setInterval(() => {
    void tick().catch((err) => console.error('[scheduler] tick failed:', err));
  }, 60_000);
  interval.unref();
  console.log('[scheduler] autonomous topic scout active (interval set in admin Settings)');
}
