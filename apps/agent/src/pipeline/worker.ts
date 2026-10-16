// Worker loop — polls Postgres and atomically claims queued articles
// (FOR UPDATE SKIP LOCKED), so multiple worker processes are safe. Claims
// rotate across platforms, so one platform's backlog never starves another of
// worker capacity, and a paused platform's articles are simply not claimed.
//
// The poll does two jobs. It claims work, and every Nth tick it reaps: a claim
// carries a lease now (012_stage_lease.sql), and a lease nobody is renewing is
// how an abandoned run becomes visible while this process is still alive.
// Recovery used to happen only at boot, which is why a stage that stopped
// making progress sat in 'running' for 2702 minutes - the code that would have
// noticed only ran when the container was replaced.
//
// A lapsed lease is re-queued, not timed out. A stage that is merely slow or
// stuck keeps renewing and is stopped by its own budget; the only way a lease
// lapses is that the process holding it stopped - a redeploy, a memory kill, a
// scale-in - and that process never got to spend the stage's budget.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createLogger } from '../lib/log.js';
import { q } from '../db/pool.js';
import { admitClaimed, dropStartedEvents, stageMayStartSql } from './eventWindow.js';
import { STAGE_LEASE_SECONDS } from './lease.js';
import { activePlatforms } from './platforms.js';
import { STAGE_AGENT, runStage } from './runner.js';
import { recoverStaleScoutRuns } from './scout.js';
import type { ArticleRow, Stage } from './types.js';

const log = createLogger('worker');

/**
 * This process, as every claim it takes records it. The Cloud Run revision
 * leads when there is one, so `claimed_by` and the reaper's log say which
 * deploy a lost claim belonged to rather than only a random id.
 */
export function workerIdentity(revision: string, suffix: string): string {
  return revision ? `worker-${revision}-${suffix}` : `worker-${suffix}`;
}

export const workerId = workerIdentity(config.revision, randomUUID().slice(0, 8));
let active = 0;
let stopped = false;
let ticks = 0;
let poller: NodeJS.Timeout | undefined;
const inFlightTicks = new Set<Promise<void>>();

/**
 * Automatic re-queues one attempt gets when the worker holding it stops. Two
 * covers a redeploy landing on a restart; a third lapse on the same attempt
 * says the stage itself is what keeps taking the instance down (a memory kill
 * is the usual one), and looping would only take it down again.
 */
export const MAX_LEASE_REQUEUES = 2;

/** The session line of a run whose worker stopped and whose stage was re-queued. */
export const LEASE_REQUEUED_MESSAGE = 'worker instance stopped mid-stage; stage re-queued';

/** The session line of a run this process let go of as it shut down. */
export const SHUTDOWN_RELEASED_MESSAGE = 'worker instance shut down mid-stage; stage re-queued';

/** What a card says once its worker has stopped under it more than the cap allows. */
export function workerStoppedRepeatedlyMessage(stage: Exclude<Stage, 'done'>): string {
  return (
    `The worker instance running the ${stage} stage (${STAGE_AGENT[stage]} agent) stopped ` +
    `${MAX_LEASE_REQUEUES + 1} times before the stage could finish, so it was not re-queued ` +
    'again. Any partial output has been saved as a draft - use Retry from this stage to run it again.'
  );
}

/**
 * What one claim writes into `claimed_by`: this worker, plus a token unique to
 * the claim itself.
 *
 * The suffix is load-bearing. Every article write a run makes is guarded on
 * the claim it started under (lease.ts `updateClaimed`), and `claimed_by` is
 * the identity in that guard - but a per-process id alone cannot tell "still
 * mine" from "cancelled, re-queued and claimed again by this same process".
 * Both are `status = 'running'` under the same worker id, so the run an
 * operator cancelled would find its guard passing again the moment the retry
 * it was cancelled for gets picked up here, and would write its abandoned
 * output over the run that replaced it. A fresh token per claim makes every
 * claim its own identity, whichever endpoint re-queued the article.
 */
export function claimIdentity(): string {
  return `${workerId}/${randomUUID()}`;
}

/** When this process last claimed for each platform - the rotation's memory. */
const lastClaimedAt = new Map<string, Date>();

/**
 * Claim the next queued article of one of `platformIds`, taking the lease with
 * it. The claim and the lease are one statement on purpose: a worker that died
 * between the two would hold a claim nothing could ever reap.
 *
 * Which platform goes next is a fair rotation, not the globally oldest row - a
 * platform with a deep backlog would otherwise take every claim until it was
 * through it. In order:
 *  1. the platform with the fewest stages running right now, across every
 *     worker (the database is the only view all instances share), so each
 *     platform with work gets an equal share of the running capacity;
 *  2. then the platform this worker claimed for longest ago (never first), so
 *     a worker running one stage at a time alternates between platforms;
 *  3. then, within the platform, the longest-waiting article.
 *
 * An event-bound article inside its lead window is not claimable at all
 * (eventWindow.ts), so it waits without taking anyone's turn.
 *
 * `attempt` is not touched. It counts passes an operator asked for, not claims
 * the pipeline took: a stage re-queued after a crash is the same attempt
 * resumed, and only a retry makes it the next one.
 */
export async function claimNext(platformIds: readonly string[]): Promise<ArticleRow | null> {
  if (platformIds.length === 0) return null;
  const served = [...lastClaimedAt].filter(([platformId]) => platformIds.includes(platformId));
  const rows = await q<ArticleRow>(
    `UPDATE articles
     SET status = 'running', claimed_by = $1, claimed_at = now(), heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
     WHERE id = (
       SELECT a.id FROM articles a
       LEFT JOIN (
         SELECT platform_id, count(*) n FROM articles WHERE status = 'running' GROUP BY platform_id
       ) busy ON busy.platform_id = a.platform_id
       LEFT JOIN unnest($4::text[], $5::timestamptz[]) served(platform_id, claimed_at)
         ON served.platform_id = a.platform_id
       WHERE a.status = 'queued' AND a.stage <> 'done' AND a.platform_id = ANY($3::text[])
         AND ${stageMayStartSql('a')}
       ORDER BY COALESCE(busy.n, 0) ASC, served.claimed_at ASC NULLS FIRST, a.updated_at ASC
       LIMIT 1
       FOR UPDATE OF a SKIP LOCKED
     )
     RETURNING *`,
    [
      claimIdentity(),
      STAGE_LEASE_SECONDS,
      platformIds,
      served.map(([platformId]) => platformId),
      served.map(([, at]) => at),
    ],
  );
  const claimed = rows[0];
  if (!claimed) return null;
  lastClaimedAt.set(claimed.platform_id, new Date());
  return claimed;
}

/** True on every Nth poll - the reaper's duty cycle. */
export function isReapTick(tickCount: number, every = config.reaperEveryTicks): boolean {
  return every > 0 && tickCount % every === 0;
}

/**
 * A claim nobody is holding any more: still 'running', with a lease that has
 * run out (or never existed). Both the tick reaper and boot recovery select on
 * exactly this, so the two paths can never disagree about which rows are theirs.
 */
const CLAIM_LAPSED =
  "status = 'running' AND stage <> 'done' AND (lease_expires_at IS NULL OR lease_expires_at < now())";

const CLAIM_CLEARED =
  'claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL';

/**
 * Put every article whose claim lapsed back in the queue, or fail it once the
 * attempt has used up its automatic re-queues.
 *
 * This is the case a stage's own budget cannot cover: the process that held
 * the claim is gone (recycled, killed, scaled in), so nobody is left to notice
 * its budget. The lease is what outlives it, and any live worker can act on it.
 * The stage, the draft and every partial output stay on the row - the next
 * claim runs the same stage again on the same attempt.
 *
 * Per row, because the message names the stage and the log says who lost it.
 * Each update re-checks the lapse and the claim it read, so two workers
 * sweeping at once cannot both act on the same row.
 */
export async function reapExpiredLeases(): Promise<number> {
  const lapsed = await q<{
    // `stage <> 'done'` in CLAIM_LAPSED is what makes this type honest: a
    // finished article has no agent to name, and the claim never takes one.
    id: string;
    stage: Exclude<Stage, 'done'>;
    claimed_by: string | null;
    lease_requeues: number;
    elapsed_seconds: string;
  }>(
    `SELECT id, stage, claimed_by, lease_requeues,
            EXTRACT(EPOCH FROM (now() - COALESCE(claimed_at, updated_at))) elapsed_seconds
     FROM articles
     WHERE ${CLAIM_LAPSED}`,
  );

  let handled = 0;
  for (const row of lapsed) {
    const exhausted = row.lease_requeues >= MAX_LEASE_REQUEUES;
    const message = exhausted ? workerStoppedRepeatedlyMessage(row.stage) : LEASE_REQUEUED_MESSAGE;
    const updated = exhausted
      ? // 'transient': nothing about the content failed, and a retry once the
        // worker is stable is exactly what it needs.
        await q(
          `UPDATE articles
           SET status = 'failed', error = $3, failure_class = 'transient', ${CLAIM_CLEARED},
               updated_at = now()
           WHERE id = $1 AND claimed_by IS NOT DISTINCT FROM $2 AND ${CLAIM_LAPSED}
           RETURNING id`,
          [row.id, row.claimed_by, message],
        )
      : // `updated_at` is left alone so the article keeps its place in the
        // queue: claimNext takes the longest-waiting row first, and this one
        // was already being worked on.
        await q(
          `UPDATE articles
           SET status = 'queued', lease_requeues = lease_requeues + 1, ${CLAIM_CLEARED}
           WHERE id = $1 AND claimed_by IS NOT DISTINCT FROM $2 AND ${CLAIM_LAPSED}
           RETURNING id`,
          [row.id, row.claimed_by],
        );
    // Someone renewed the lease, cancelled the article or swept it first.
    if (updated.length === 0) continue;
    await q(
      `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
       WHERE article_id = $1 AND status = 'running'`,
      [row.id, message],
    );
    handled += 1;
    const fields = {
      article_id: row.id,
      stage: row.stage,
      agent: STAGE_AGENT[row.stage],
      cause: 'lease',
      claimed_by: row.claimed_by,
      elapsed_seconds: Math.round(Number(row.elapsed_seconds)),
      lease_requeues: exhausted ? row.lease_requeues : row.lease_requeues + 1,
      max_lease_requeues: MAX_LEASE_REQUEUES,
    };
    if (exhausted) log.error('stage failed: its worker stopped repeatedly', fields);
    else log.warn('stage re-queued: its worker stopped', fields);
  }
  return handled;
}

async function tick(): Promise<void> {
  if (stopped) return;
  // Before the enable check and before the concurrency check: a lease runs out
  // whether or not this worker is taking new work, and a worker that is busy
  // is exactly the one that needs to notice the run it lost.
  ticks += 1;
  if (isReapTick(ticks)) {
    await reapExpiredLeases();
    await dropStartedEvents();
  }

  if (active >= config.workerConcurrency) return;
  const platformIds = (await activePlatforms()).map((platform) => platform.id);

  while (!stopped && active < config.workerConcurrency) {
    const article = await claimNext(platformIds);
    if (!article) return;
    // Claimed as the process was told to stop: the claim is already this
    // worker's, so releaseHeldClaims hands it back rather than it running here.
    if (stopped) return;
    if (!(await admitClaimed(article))) return;
    active += 1;
    void runStage(article)
      .catch((err) => console.error('[worker] runStage crashed:', err))
      .finally(() => {
        active -= 1;
      });
  }
}

export function startWorker(): void {
  stopped = false;
  console.log(`[worker] ${workerId} polling every ${config.pollMs}ms (concurrency ${config.workerConcurrency})`);
  poller = setInterval(() => {
    const running: Promise<void> = tick()
      .catch((err) => console.error('[worker] tick failed:', err))
      .finally(() => inFlightTicks.delete(running));
    inFlightTicks.add(running);
  }, config.pollMs);
  poller.unref();
}

/**
 * Stop taking new work, and wait for any poll already in progress to finish.
 * The wait is the point: a claim that lands after the shutdown released this
 * worker's claims would be held by nobody until its lease ran out.
 */
export async function stopWorker(): Promise<void> {
  stopped = true;
  clearInterval(poller);
  await Promise.allSettled([...inFlightTicks]);
}

/**
 * Hand every article this process holds back to the queue, for a shutdown.
 *
 * Guarded on the claim - only rows whose `claimed_by` is one of this worker's
 * claim identities - so nothing another instance holds is touched. The runs
 * still in flight here find their claim gone at their next write or renewal
 * and stop without writing (runner.ts `updateArticle`), which is what keeps an
 * abandoned run from landing on top of the row the next claim is working.
 *
 * Not counted against MAX_LEASE_REQUEUES: a shutdown that let go properly is
 * the platform's own doing, not a sign the stage is taking the instance down.
 */
export async function releaseHeldClaims(holder: string = workerId): Promise<number> {
  const released = await q<{ id: string; stage: Stage }>(
    `UPDATE articles SET status = 'queued', ${CLAIM_CLEARED}
     WHERE status = 'running' AND starts_with(claimed_by, $1 || '/')
     RETURNING id, stage`,
    [holder],
  );
  if (released.length === 0) return 0;
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
     WHERE status = 'running' AND article_id = ANY($1)`,
    [released.map((r) => r.id), SHUTDOWN_RELEASED_MESSAGE],
  );
  log.warn('released claims at shutdown', {
    worker_id: holder,
    articles: released.map((r) => `${r.id} (${r.stage})`),
  });
  return released.length;
}

/**
 * Recover work stranded in 'running' by a previous crashed process.
 *
 * Boot behaviour, and the same rule as the tick reaper - the same selection,
 * the same re-queue and the same cap - so a lapsed claim ends up in the same
 * state whichever of the two finds it first. A live claim on another instance
 * renews its lease and is left alone.
 */
export async function recoverStranded(): Promise<void> {
  const recovered = await reapExpiredLeases();
  if (recovered > 0) console.log(`[worker] recovered ${recovered} stranded article(s)`);
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
