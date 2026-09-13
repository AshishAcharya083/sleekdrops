// Scout run orchestration — a topic-scout sweep runs outside the article
// pipeline (it produces topics, not articles). Triggered from the admin panel.
//
// The sweep is a detached background task, so the only thing stopping two of
// them from running at once is the 'running' row in scout_runs. That row is a
// lock, and a lock a dead process can hold forever is a lock that eventually
// blocks everything: this module gives it a lease (heartbeat_at, renewed while
// the run is alive), the same 30-minute stale threshold recoverStranded() uses
// for articles, and a way for an operator to see and release it by hand.
import { q } from '../db/pool.js';
import { UsageTracker } from '../llm/index.js';
import { runTopicScout } from '../agents/topicScout.js';
import { modelFor } from './runner.js';

/** How long a run's lease survives without a heartbeat. Matches recoverStranded(). */
const LEASE_MINUTES = 30;

/** How often a live run renews its lease - well inside the stale threshold. */
const HEARTBEAT_MS = 60_000;

/** Interpolates a module constant, never caller input. */
const FRESH_LEASE = `heartbeat_at > now() - interval '${LEASE_MINUTES} minutes'`;

/** The run holding the scout lock, as an operator needs to read it. */
export interface ScoutLock {
  id: string;
  /** pg reads timestamptz back as a Date; it serialises to ISO for the panel. */
  started_at: Date;
  heartbeat_at: Date;
  /** Seconds since the run started - how long the lock has been held. */
  age_seconds: number;
  /** Seconds since the run last reported it was alive. */
  heartbeat_age_seconds: number;
}

const LOCK_COLUMNS = `id, started_at, heartbeat_at,
        EXTRACT(EPOCH FROM now() - started_at)::int age_seconds,
        EXTRACT(EPOCH FROM now() - heartbeat_at)::int heartbeat_age_seconds`;

/** "2h 5m" / "45s" - an age an operator can read at a glance. */
export function formatAge(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The refusal an operator reads when a sweep is turned away. It names the run
 * holding the lock, when it took it and how long it has held it, because
 * "already in progress" alone leaves nothing to look up or act on.
 */
export function describeScoutLock(lock: ScoutLock): string {
  return (
    `a scout run is already in progress: run ${lock.id} started ${lock.started_at.toISOString()} ` +
    `(${formatAge(lock.age_seconds)} ago, last heartbeat ${formatAge(lock.heartbeat_age_seconds)} ago). ` +
    `Clear the lock from the Topics tab if that run is stuck.`
  );
}

/** The live run holding the scout lock, or null when the lock is free. */
export async function heldScoutLock(): Promise<ScoutLock | null> {
  const [lock] = await q<ScoutLock>(
    `SELECT ${LOCK_COLUMNS} FROM scout_runs
     WHERE status = 'running' AND ${FRESH_LEASE}
     ORDER BY started_at DESC LIMIT 1`,
  );
  return lock ?? null;
}

export async function isScoutRunning(): Promise<boolean> {
  return (await heldScoutLock()) !== null;
}

/** Fail a run's still-open sessions, so the Sessions tab loses the phantom too. */
async function failScoutSessions(runIds: string[], reason: string): Promise<void> {
  if (runIds.length === 0) return;
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = $2, ended_at = now()
     WHERE scout_run_id = ANY($1) AND status = 'running'`,
    [runIds, reason],
  );
}

/**
 * Release scout locks whose lease expired with the process that held them.
 * Same threshold and terminal-state treatment recoverStranded() gives
 * articles, so a sweep killed mid-run never blocks the next one.
 */
export async function recoverStaleScoutRuns(): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE scout_runs SET status = 'failed', error = 'process restarted mid-run', ended_at = now()
     WHERE status = 'running' AND NOT (${FRESH_LEASE})
     RETURNING id`,
  );
  if (rows.length === 0) return;
  await failScoutSessions(rows.map((r) => r.id), 'process restarted mid-run');
  console.log(`[scout] released ${rows.length} stale scout lock(s)`);
}

/**
 * Operator escape hatch: release the lock now, without waiting out the lease.
 * Returns the runs it released. A run whose process is genuinely still alive
 * stops renewing (the heartbeat only touches rows still marked 'running'), so
 * clearing cannot leave a row flapping between states.
 */
export async function clearScoutLock(): Promise<ScoutLock[]> {
  const released = await q<ScoutLock>(
    `UPDATE scout_runs SET status = 'failed', error = 'lock cleared by operator', ended_at = now()
     WHERE status = 'running'
     RETURNING ${LOCK_COLUMNS}`,
  );
  await failScoutSessions(released.map((r) => r.id), 'scout lock cleared by operator');
  return released;
}

/** Starts a sweep in the background; returns the scout_runs row id. */
export async function startScoutRun(): Promise<string> {
  const [run] = await q<{ id: string }>('INSERT INTO scout_runs DEFAULT VALUES RETURNING id');
  void (async () => {
    const tracker = new UsageTracker();
    // The lease is renewed only while the row still says 'running', so an
    // operator who cleared the lock is not overruled by the task that lost it.
    const heartbeat = setInterval(() => {
      void q("UPDATE scout_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'", [
        run.id,
      ]).catch((err) => console.error(`[scout] heartbeat failed for run ${run.id}:`, err));
    }, HEARTBEAT_MS);
    heartbeat.unref();
    // Model resolution is inside the try on purpose: it fails when the engine
    // toggle names Claude and no credential is set, and a throw out here would
    // leave scout_runs stuck on 'running' — which isScoutRunning() reads, so
    // every later sweep would refuse to start with nothing explaining why.
    let session: { id: string } | undefined;
    try {
      const model = await modelFor('topic_scout');
      [session] = await q<{ id: string }>(
        `INSERT INTO agent_sessions (scout_run_id, agent, model) VALUES ($1, 'topic_scout', $2) RETURNING id`,
        [run.id, model],
      );
      const topics = await runTopicScout(model, tracker, run.id);
      await q(
        `UPDATE scout_runs SET status = 'done', topics_found = $2, ended_at = now() WHERE id = $1`,
        [run.id, topics.length],
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
      console.log(`[scout] run ${run.id} found ${topics.length} topic(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await q(`UPDATE scout_runs SET status = 'failed', error = $2, ended_at = now() WHERE id = $1`, [
        run.id,
        message,
      ]);
      // No session row when the model itself could not be resolved — write one
      // so the Sessions tab carries the reason rather than only scout_runs.
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
          [run.id, message],
        );
      }
      console.error(`[scout] run ${run.id} failed: ${message}`);
    } finally {
      clearInterval(heartbeat);
    }
  })();
  return run.id;
}
