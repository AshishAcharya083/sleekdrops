// Worker loop — polls Postgres and atomically claims queued articles
// (FOR UPDATE SKIP LOCKED), so multiple worker processes are safe. The
// devteam-platform claim pattern, minus the per-project round-robin.
//
// The poll does two jobs. It claims work, and every Nth tick it reaps: a claim
// carries a lease now (012_stage_lease.sql), and a lease nobody is renewing is
// how a wedged or abandoned run becomes visible while this process is still
// alive. Recovery used to happen only at boot, which is why a stage that
// stopped making progress sat in 'running' for 2702 minutes - the code that
// would have noticed only ran when the container was replaced.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../lib/log.js';
import { getSetting, q } from '../db/pool.js';
import { STAGE_AGENT, STAGE_TIMEOUT_SECONDS, runStage } from './runner.js';
import { STAGE_LEASE_SECONDS } from './lease.js';
import { recoverStaleScoutRuns } from './scout.js';
import { stageBudgetSeconds, stageTimeoutMessage } from './stageTimeout.js';
import type { ArticleRow, Stage } from './types.js';

const log = createLogger('worker');

const workerId = `worker-${randomUUID().slice(0, 8)}`;
let active = 0;
let stopped = false;
let ticks = 0;

/**
 * Claim the longest-waiting queued article, taking the lease with it. The
 * claim and the lease are one statement on purpose: a worker that died between
 * the two would hold a claim nothing could ever reap.
 */
export async function claimNext(): Promise<ArticleRow | null> {
  const rows = await q<ArticleRow>(
    `UPDATE articles
     SET status = 'running', claimed_by = $1, claimed_at = now(), heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => $2), attempt = attempt + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM articles
       WHERE status = 'queued' AND stage <> 'done'
       ORDER BY updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId, STAGE_LEASE_SECONDS],
  );
  return rows[0] ?? null;
}

/** True on every Nth poll - the reaper's duty cycle. */
export function isReapTick(tickCount: number, every = config.reaperEveryTicks): boolean {
  return every > 0 && tickCount % every === 0;
}

/**
 * Stop every article whose lease has run out.
 *
 * This is the case a stage's own budget cannot cover: the process that held
 * the claim is gone (recycled, killed, wedged below the level its own timer
 * runs at), so nobody is left to notice its budget. The lease is what outlives
 * it, and any live worker can act on it - which is the point, because waiting
 * for a restart is what left a run sitting in 'running' for two days.
 *
 * Per row rather than one statement, because the message names the stage, the
 * agent and how long it actually ran. Each update re-checks the lease it read,
 * so two workers reaping at once cannot both claim the same row.
 */
export async function reapExpiredLeases(): Promise<number> {
  const expired = await q<{
    // `stage <> 'done'` below is what makes this type honest: a finished
    // article has no agent to name, and the claim never takes one anyway.
    id: string;
    stage: Exclude<Stage, 'done'>;
    claimed_by: string | null;
    elapsed_seconds: string;
  }>(
    `SELECT id, stage, claimed_by,
            EXTRACT(EPOCH FROM (now() - COALESCE(claimed_at, updated_at))) elapsed_seconds
     FROM articles
     WHERE status = 'running' AND stage <> 'done' AND lease_expires_at < now()`,
  );

  let reaped = 0;
  for (const row of expired) {
    const agent = STAGE_AGENT[row.stage];
    const budgetSeconds = stageBudgetSeconds(STAGE_TIMEOUT_SECONDS[row.stage]);
    const elapsedSeconds = Number(row.elapsed_seconds);
    const message = stageTimeoutMessage({
      agent,
      stage: row.stage,
      budgetSeconds,
      elapsedSeconds,
      // The worker that was running this is not this one, so what it was
      // waiting on died with it. Saying so beats naming nothing.
      lastCall: '',
      cause: 'lease',
    });
    const claimed = await q(
      `UPDATE articles
       SET status = 'timed_out', error = $2, claimed_by = NULL, claimed_at = NULL,
           heartbeat_at = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running' AND lease_expires_at < now()
       RETURNING id`,
      [row.id, message],
    );
    // Someone renewed the lease, cancelled the article or reaped it first.
    if (claimed.length === 0) continue;
    await q(
      `UPDATE agent_sessions SET status = 'timed_out', error = $2, ended_at = now()
       WHERE article_id = $1 AND status = 'running'`,
      [row.id, message],
    );
    reaped += 1;
    log.warn('stage timed out', {
      article_id: row.id,
      stage: row.stage,
      agent,
      cause: 'lease',
      budget_seconds: budgetSeconds,
      elapsed_seconds: Math.round(elapsedSeconds),
      claimed_by: row.claimed_by,
    });
  }
  return reaped;
}

async function tick(): Promise<void> {
  if (stopped) return;
  // Before the enable check and before the concurrency check: a lease runs out
  // whether or not this worker is taking new work, and a worker that is busy
  // is exactly the one that needs to notice the run it lost.
  ticks += 1;
  if (isReapTick(ticks)) await reapExpiredLeases();

  if (active >= config.workerConcurrency) return;
  const enabled = await getSetting<boolean>('worker_enabled', true);
  if (!enabled) return;

  while (active < config.workerConcurrency) {
    const article = await claimNext();
    if (!article) return;
    active += 1;
    void runStage(article)
      .catch((err) => console.error('[worker] runStage crashed:', err))
      .finally(() => {
        active -= 1;
      });
  }
}

export function startWorker(): void {
  console.log(`[worker] ${workerId} polling every ${config.pollMs}ms (concurrency ${config.workerConcurrency})`);
  const interval = setInterval(() => {
    void tick().catch((err) => console.error('[worker] tick failed:', err));
  }, config.pollMs);
  interval.unref();
}

export function stopWorker(): void {
  stopped = true;
}

/**
 * Recover work stranded in 'running' by a previous crashed process.
 *
 * Boot behaviour, and deliberately a re-queue rather than a timeout: a process
 * that died never got to spend the stage's budget, so the honest thing is to
 * let the stage run. It keys on the lease rather than a hardcoded 30-minute
 * window on `claimed_at` - a live claim on another instance renews its lease
 * and is left alone, and an abandoned one is recoverable the moment its lease
 * lapses instead of at a fixed half hour.
 */
export async function recoverStranded(): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE articles
     SET status = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
         lease_expires_at = NULL, updated_at = now()
     WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING id`,
  );
  if (rows.length > 0) {
    console.log(`[worker] re-queued ${rows.length} stranded article(s)`);
    await q(
      `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
       WHERE status = 'running' AND article_id = ANY($1)`,
      [rows.map((r) => r.id), 'process restarted mid-run; stage re-queued'],
    );
  }
  // A session left open on an article that is no longer running - reaped,
  // cancelled, or recovered by another instance - can never be closed by the
  // process that opened it, so it would show as a live run forever.
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = 'process restarted mid-run', ended_at = now()
     WHERE status = 'running' AND article_id IN (SELECT id FROM articles WHERE status <> 'running')`,
  );
  // Topic-search jobs use their own queue but share the same recovery pass.
  await recoverStaleScoutRuns();
}
