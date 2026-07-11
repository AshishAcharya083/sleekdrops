// Scout run orchestration — a topic-scout sweep runs outside the article
// pipeline (it produces topics, not articles). Triggered from the admin panel.
import { q } from '../db/pool.js';
import { UsageTracker } from '../llm/openrouter.js';
import { runTopicScout } from '../agents/topicScout.js';
import { modelFor } from './runner.js';

export async function isScoutRunning(): Promise<boolean> {
  const rows = await q("SELECT 1 FROM scout_runs WHERE status = 'running' LIMIT 1");
  return rows.length > 0;
}

/** Starts a sweep in the background; returns the scout_runs row id. */
export async function startScoutRun(): Promise<string> {
  const [run] = await q<{ id: string }>('INSERT INTO scout_runs DEFAULT VALUES RETURNING id');
  void (async () => {
    const model = await modelFor('topic_scout');
    const tracker = new UsageTracker();
    const [session] = await q<{ id: string }>(
      `INSERT INTO agent_sessions (scout_run_id, agent, model) VALUES ($1, 'topic_scout', $2) RETURNING id`,
      [run.id, model],
    );
    try {
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
      await q(
        `UPDATE agent_sessions SET status = 'failed', error = $2, tokens_input = $3,
           tokens_output = $4, cost_usd = $5, llm_calls = $6, ended_at = now()
         WHERE id = $1`,
        [session.id, message, tracker.tokensInput, tracker.tokensOutput, tracker.costUsd, tracker.llmCalls],
      );
      console.error(`[scout] run ${run.id} failed: ${message}`);
    }
  })();
  return run.id;
}
