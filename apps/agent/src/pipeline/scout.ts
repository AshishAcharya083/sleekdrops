// Durable topic-scout queue. Requests are cheap database inserts, one per
// platform edition; a worker claims them in order and runs at most one per
// platform at a time across all agent instances, so platforms scout side by
// side and never wait on each other. A recycled process leaves its job
// recoverable instead of leaving an operator-facing lock to diagnose and clear.
import { config } from '../config.js';
import { pool, q } from '../db/pool.js';
import { UsageTracker } from '../llm/index.js';
import { runTopicScout } from '../agents/topicScout.js';
import { resolvePromptContext } from '../agents/context.js';
import { activePlatforms } from './platforms.js';
import { modelFor } from './runner.js';

/** How long a sweep's heartbeat may go quiet before it stops holding the lock. */
const STALE_MINUTES = 30;
const HEARTBEAT_MS = 60_000;
const FRESH_RUN = `heartbeat_at > now() - interval '${STALE_MINUTES} minutes'`;

/** Platforms with a scout running in this process. */
const active = new Set<string>();
let stopped = false;

export interface ScoutQueueStatus {
  queued: number;
  running: number;
}

/** A claimed request: which platform edition it scouts. */
export interface ClaimedScoutRun {
  id: string;
  platform_id: string;
  edition_id: string;
}

/** Add a request to the durable queue. This never refuses because another run is active. */
export async function enqueueScoutRun(platformId: string, editionId: string): Promise<string> {
  const [run] = await q<{ id: string }>(
    `INSERT INTO scout_runs (status, platform_id, edition_id) VALUES ('queued', $1, $2)
     RETURNING id`,
    [platformId, editionId],
  );
  return run.id;
}

/** Small status payload for the Topics tab; internal lease details stay internal. */
export async function scoutQueueStatus(platformId: string): Promise<ScoutQueueStatus> {
  const [status] = await q<{ queued: string; running: string }>(
    `SELECT count(*) FILTER (WHERE status = 'queued') queued,
            count(*) FILTER (WHERE status = 'running' AND ${FRESH_RUN}) running
     FROM scout_runs
     WHERE platform_id = $1`,
    [platformId],
  );
  return { queued: Number(status.queued), running: Number(status.running) };
}

export async function hasPendingScoutRuns(platformId: string): Promise<boolean> {
  const status = await scoutQueueStatus(platformId);
  return status.queued > 0 || status.running > 0;
}

/** Fail still-open attempt sessions before a stranded run is retried. */
async function failScoutSessions(runIds: string[], reason: string): Promise<void> {
  if (runIds.length === 0) return;
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
     WHERE scout_run_id = ANY($1) AND status = 'running'`,
    [runIds, reason],
  );
}

/** Put work abandoned by a recycled process back at the front of the queue. */
export async function recoverStaleScoutRuns(): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE scout_runs
     SET status = 'queued', error = NULL, claimed_at = NULL, ended_at = NULL
     WHERE status = 'running' AND NOT (${FRESH_RUN})
     RETURNING id`,
  );
  if (rows.length === 0) return;
  await failScoutSessions(rows.map((r) => r.id), 'process restarted mid-run; request re-queued');
  console.log(`[scout] re-queued ${rows.length} stranded topic search(es)`);
}

export async function renewScoutHeartbeat(id: string): Promise<boolean> {
  const renewed = await q(
    "UPDATE scout_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running' RETURNING id",
    [id],
  );
  return renewed.length > 0;
}

/**
 * Claim this platform's oldest request if none of its requests is live. The
 * transaction-level advisory lock serialises this check-and-claim across Cloud
 * Run instances; queued rows remain ordinary durable work, not a lock exposed
 * to operators.
 *
 * The lock is keyed per platform, so two platforms claim and scout at the same
 * time while one platform never runs two. The key keeps the original
 * 'sleekdrops:topic-scout' text as its prefix on purpose: it is a lock name,
 * not a brand, and changing it would let an old and a new revision hold
 * different locks for the same platform during a rolling deploy.
 */
export async function claimNextScoutRun(platformId: string): Promise<ClaimedScoutRun | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sleekdrops:topic-scout:' || $1, 0))",
      [platformId],
    );
    const live = await client.query(
      `SELECT 1 FROM scout_runs
       WHERE platform_id = $1 AND status = 'running' AND ${FRESH_RUN} LIMIT 1`,
      [platformId],
    );
    if (live.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const next = await client.query<ClaimedScoutRun>(
      `SELECT id, platform_id, edition_id FROM scout_runs
       WHERE platform_id = $1 AND status = 'queued'
       ORDER BY started_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [platformId],
    );
    const run = next.rows[0];
    if (!run) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE scout_runs
       SET status = 'running', claimed_at = now(), heartbeat_at = now(), error = NULL, ended_at = NULL
       WHERE id = $1`,
      [run.id],
    );
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runClaimedScout({
  id,
  platform_id: platformId,
  edition_id: editionId,
}: ClaimedScoutRun): Promise<void> {
  const tracker = new UsageTracker();
  const heartbeat = setInterval(() => {
    void renewScoutHeartbeat(id).catch((err) =>
      console.error(`[scout] heartbeat failed for run ${id}:`, err),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let session: { id: string } | undefined;
  try {
    const model = await modelFor('topic_scout', platformId);
    [session] = await q<{ id: string }>(
      `INSERT INTO agent_sessions (scout_run_id, platform_id, agent, model)
       VALUES ($1, $2, 'topic_scout', $3) RETURNING id`,
      [id, platformId, model],
    );
    const topics = await runTopicScout(
      await resolvePromptContext(platformId, editionId),
      model,
      tracker,
      id,
    );
    await q(
      `UPDATE scout_runs SET status = 'done', topics_found = $2, ended_at = now() WHERE id = $1`,
      [id, topics.length],
    );
    await q(
      `UPDATE agent_sessions SET status = 'done', summary = $2, tokens_input = $3,
         tokens_output = $4, cost_usd = $5, llm_calls = $6, ended_at = now()
       WHERE id = $1`,
      [
        session.id,
        `found ${topics.length} new topic(s): ${topics.map((t) => t.title).join(' | ').slice(0, 400)}`,
        tracker.tokensInput,
        tracker.tokensOutput,
        tracker.costUsd,
        tracker.llmCalls,
      ],
    );
    console.log(`[scout] run ${id} found ${topics.length} topic(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await q(`UPDATE scout_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1`, [
      id,
      message,
    ]);
    if (session) {
      await q(
        `UPDATE agent_sessions SET status = 'failed', error = $2, tokens_input = $3,
           tokens_output = $4, cost_usd = $5, llm_calls = $6, ended_at = now()
         WHERE id = $1`,
        [session.id, message, tracker.tokensInput, tracker.tokensOutput, tracker.costUsd, tracker.llmCalls],
      );
    } else {
      await q(
        `INSERT INTO agent_sessions (scout_run_id, platform_id, agent, status, summary, error, ended_at)
         VALUES ($1, $2, 'topic_scout', 'failed', 'scout could not start', $3, now())`,
        [id, platformId, message],
      );
    }
    console.error(`[scout] run ${id} failed: ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Start the next request of every platform that is not paused and has no
 * scout running here, one request per platform at a time. Safe to call eagerly
 * after enqueue and from the poller. Resolves once every run it started ends.
 */
export async function processScoutQueue(): Promise<void> {
  if (stopped) return;
  await recoverStaleScoutRuns();
  const runs: Promise<void>[] = [];
  for (const platform of await activePlatforms()) {
    if (stopped || active.has(platform.id)) continue;
    const run = await claimNextScoutRun(platform.id);
    if (!run) continue;
    active.add(platform.id);
    runs.push(
      runClaimedScout(run).finally(() => {
        active.delete(platform.id);
        queueMicrotask(() =>
          void processScoutQueue().catch((err) => console.error('[scout] queue failed:', err)),
        );
      }),
    );
  }
  await Promise.all(runs);
}

export function startScoutWorker(): void {
  stopped = false;
  void processScoutQueue().catch((err) => console.error('[scout] queue failed:', err));
  const interval = setInterval(() => {
    void processScoutQueue().catch((err) => console.error('[scout] queue failed:', err));
  }, config.pollMs);
  interval.unref();
  console.log(`[scout] queue worker polling every ${config.pollMs}ms`);
}

export function stopScoutWorker(): void {
  stopped = true;
}
