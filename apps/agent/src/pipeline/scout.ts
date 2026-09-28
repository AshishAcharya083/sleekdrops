// Durable topic-scout queue. Requests are cheap database inserts; a single
// worker claims them in order and runs them one at a time across all agent
// instances. A recycled process leaves its job recoverable instead of leaving
// an operator-facing lock to diagnose and clear.
import { config } from '../config.js';
import { pool, q } from '../db/pool.js';
import { UsageTracker } from '../llm/index.js';
import { runTopicScout } from '../agents/topicScout.js';
import { modelFor } from './runner.js';

/** How long a sweep's heartbeat may go quiet before it stops holding the lock. */
const STALE_MINUTES = 30;
const HEARTBEAT_MS = 60_000;
const FRESH_RUN = `heartbeat_at > now() - interval '${STALE_MINUTES} minutes'`;

let active = false;
let stopped = false;

export interface ScoutQueueStatus {
  queued: number;
  running: number;
}

/** Add a request to the durable queue. This never refuses because another run is active. */
export async function enqueueScoutRun(): Promise<string> {
  const [run] = await q<{ id: string }>(
    "INSERT INTO scout_runs (status) VALUES ('queued') RETURNING id",
  );
  return run.id;
}

/** Small status payload for the Topics tab; internal lease details stay internal. */
export async function scoutQueueStatus(): Promise<ScoutQueueStatus> {
  const [status] = await q<{ queued: string; running: string }>(
    `SELECT count(*) FILTER (WHERE status = 'queued') queued,
            count(*) FILTER (WHERE status = 'running' AND ${FRESH_RUN}) running
     FROM scout_runs`,
  );
  return { queued: Number(status.queued), running: Number(status.running) };
}

export async function hasPendingScoutRuns(): Promise<boolean> {
  const status = await scoutQueueStatus();
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
 * Claim the oldest request if no live request is running. The transaction-level
 * advisory lock serialises this check-and-claim across Cloud Run instances;
 * queued rows remain ordinary durable work, not a lock exposed to operators.
 */
export async function claimNextScoutRun(): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sleekdrops:topic-scout', 0))");
    const live = await client.query(
      `SELECT 1 FROM scout_runs WHERE status = 'running' AND ${FRESH_RUN} LIMIT 1`,
    );
    if (live.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const next = await client.query<{ id: string }>(
      `SELECT id FROM scout_runs
       WHERE status = 'queued'
       ORDER BY started_at ASC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const id = next.rows[0]?.id;
    if (!id) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE scout_runs
       SET status = 'running', claimed_at = now(), heartbeat_at = now(), error = NULL, ended_at = NULL
       WHERE id = $1`,
      [id],
    );
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runClaimedScout(id: string): Promise<void> {
  const tracker = new UsageTracker();
  const heartbeat = setInterval(() => {
    void renewScoutHeartbeat(id).catch((err) =>
      console.error(`[scout] heartbeat failed for run ${id}:`, err),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let session: { id: string } | undefined;
  try {
    const model = await modelFor('topic_scout');
    [session] = await q<{ id: string }>(
      `INSERT INTO agent_sessions (scout_run_id, agent, model)
       VALUES ($1, 'topic_scout', $2) RETURNING id`,
      [id, model],
    );
    const topics = await runTopicScout(model, tracker, id);
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
        `INSERT INTO agent_sessions (scout_run_id, agent, status, summary, error, ended_at)
         VALUES ($1, 'topic_scout', 'failed', 'scout could not start', $2, now())`,
        [id, message],
      );
    }
    console.error(`[scout] run ${id} failed: ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Drain one request at a time. Safe to call eagerly after enqueue and from the poller. */
export async function processScoutQueue(): Promise<void> {
  if (stopped || active) return;
  await recoverStaleScoutRuns();
  const id = await claimNextScoutRun();
  if (!id) return;
  active = true;
  try {
    await runClaimedScout(id);
  } finally {
    active = false;
    queueMicrotask(() =>
      void processScoutQueue().catch((err) => console.error('[scout] queue failed:', err)),
    );
  }
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
