// Worker loop — polls Postgres and atomically claims queued articles
// (FOR UPDATE SKIP LOCKED), so multiple worker processes are safe. The
// devteam-platform claim pattern, minus the per-project round-robin.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getSetting, q } from '../db/pool.js';
import { runStage } from './runner.js';
import type { ArticleRow } from './types.js';

const workerId = `worker-${randomUUID().slice(0, 8)}`;
let active = 0;
let stopped = false;

async function claimNext(): Promise<ArticleRow | null> {
  const rows = await q<ArticleRow>(
    `UPDATE articles SET status = 'running', claimed_by = $1, claimed_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM articles
       WHERE status = 'queued' AND stage <> 'done'
       ORDER BY updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId],
  );
  return rows[0] ?? null;
}

async function tick(): Promise<void> {
  if (stopped || active >= config.workerConcurrency) return;
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

/** Recover articles stranded in 'running' by a previous crashed process. */
export async function recoverStranded(): Promise<void> {
  const rows = await q(
    `UPDATE articles SET status = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE status = 'running' AND claimed_at < now() - interval '30 minutes'
     RETURNING id`,
  );
  if (rows.length > 0) console.log(`[worker] re-queued ${rows.length} stranded article(s)`);
  await q(
    `UPDATE agent_sessions SET status = 'failed', error = 'process restarted mid-run', ended_at = now()
     WHERE status = 'running' AND started_at < now() - interval '30 minutes'`,
  );
}
