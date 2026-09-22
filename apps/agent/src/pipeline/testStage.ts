// Isolated single-stage run — "what would this agent produce right now?"
//
// The same agent call the pipeline makes, against the same stored input, with
// every write to the article removed: nothing is stamped on `articles`, no
// stage routing happens, and the publisher is never reached (a test that
// pushed to D1 would not be a test). What it does record is an agent_sessions
// row marked `kind = 'test'`, because the tokens are spent either way and
// spend that does not show up in /api/usage is spend nobody can govern.
import { q } from '../db/pool.js';
import { runAngleEditor } from '../agents/angleEditor.js';
import { runAssembler } from '../agents/assembler.js';
import { runEditor } from '../agents/editor.js';
import { runImageAgent } from '../agents/imageAgent.js';
import { runKeywordStrategist } from '../agents/keywordStrategist.js';
import { runOutliner } from '../agents/outliner.js';
import { runResearcher } from '../agents/researcher.js';
import { runSeoReviewer } from '../agents/seoReviewer.js';
import { runWriter } from '../agents/writer.js';
import { UsageTracker } from '../llm/index.js';
import { parseStageParam, type StageParse } from './retry.js';
import { modelFor, NO_LLM_AGENTS, STAGE_AGENT } from './runner.js';
import { scrubSecrets } from './stageTimeout.js';
import type { ArticleRow, Stage, TopicRow } from './types.js';

export interface TestStageResult {
  sessionId: string;
  stage: Stage;
  agent: string;
  model: string | null;
  output: unknown;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  llmCalls: number;
  durationMs: number;
}

/** Stages that cannot be run in isolation: publishing is the one thing a test
 *  must never do, and 'done' runs nothing at all. */
export const UNTESTABLE_STAGES: readonly Stage[] = ['publish', 'done'];

export const UNTESTABLE_STAGE_ERROR = 'the publish stage cannot be tested in isolation';

/**
 * The `stage` body param of a test-stage request. Same validation as the retry
 * path, except that an untestable stage is refused as untestable: what a test
 * asks is which stages may be run in isolation, and publish and 'done' answer
 * that the same way, so they get the same sentence.
 */
export function parseTestStageParam(input: unknown): StageParse {
  const requested = typeof input === 'string' ? input.trim() : '';
  if ((UNTESTABLE_STAGES as readonly string[]).includes(requested)) {
    return { ok: false, error: UNTESTABLE_STAGE_ERROR };
  }
  return parseStageParam(input);
}

async function topicFor(article: ArticleRow): Promise<TopicRow | null> {
  if (!article.topic_id) return null;
  const rows = await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]);
  return rows[0] ?? null;
}

async function callAgent(
  article: ArticleRow,
  stage: Stage,
  model: string | null,
  tracker: UsageTracker,
): Promise<unknown> {
  switch (stage) {
    case 'research':
      return runResearcher(article, await topicFor(article), model!, tracker);
    case 'keyword':
      return runKeywordStrategist(article, await topicFor(article), model!, tracker);
    case 'angle':
      return runAngleEditor(article, await topicFor(article), model!, tracker);
    case 'outline':
      return runOutliner(article, model!, tracker);
    case 'write':
      return runWriter(article, await topicFor(article), model!, tracker);
    case 'seo_review':
      return runSeoReviewer(article, model!, tracker);
    case 'edit':
      return runEditor(article, model!, tracker);
    case 'assemble':
      return runAssembler(article);
    case 'image':
      return runImageAgent(article, model!);
    default:
      // publish and done are refused before this is reached.
      throw new Error(UNTESTABLE_STAGE_ERROR);
  }
}

/** Record the test run's spend against the article without touching it. */
async function recordSession(
  article: ArticleRow,
  agent: string,
  model: string | null,
  status: 'done' | 'failed',
  summary: string,
  error: string | null,
  tracker: UsageTracker,
): Promise<string> {
  const [session] = await q<{ id: string }>(
    `INSERT INTO agent_sessions
       (article_id, agent, model, status, summary, error, kind, attempt,
        tokens_input, tokens_output, cost_usd, llm_calls, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', $7, $8, $9, $10, $11, now())
     RETURNING id`,
    [
      article.id,
      agent,
      tracker.models.size > 0 ? [...tracker.models].join(',') : model,
      status,
      summary,
      error,
      article.attempt ?? 1,
      tracker.tokensInput,
      tracker.tokensOutput,
      tracker.costUsd,
      tracker.llmCalls,
    ],
  );
  return session.id;
}

/**
 * What a failure here is allowed to say. A test run spawns the same agents the
 * pipeline does, so the message is whatever an SDK wrote about the child
 * process it just ran - and that child's environment is where our credentials
 * live. It is persisted on the session and served back to the browser as the
 * 500 body, so it goes through the same scrubber runStage uses before either.
 */
function scrubbedFailure(err: unknown): Error {
  const message = scrubSecrets(err instanceof Error ? err.message : String(err));
  return new Error(message, { cause: err });
}

/**
 * Run one stage's agent against the article's stored input and return what it
 * produced. Writes nothing to `articles`; the only row this creates is the
 * test session. A failing agent is rethrown (the caller answers 500) after its
 * session has been recorded, so a failed test still shows its cost.
 */
export async function runTestStage(article: ArticleRow, stage: Stage): Promise<TestStageResult> {
  const agent = STAGE_AGENT[stage as Exclude<Stage, 'done'>];
  const tracker = new UsageTracker();
  const startedAt = Date.now();

  let model: string | null = null;
  try {
    model = NO_LLM_AGENTS.has(agent) ? null : await modelFor(agent);
  } catch (err) {
    const failure = scrubbedFailure(err);
    await recordSession(
      article,
      agent,
      null,
      'failed',
      `${stage} test could not start`,
      failure.message,
      tracker,
    );
    throw failure;
  }

  try {
    const output = await callAgent(article, stage, model, tracker);
    const sessionId = await recordSession(
      article,
      agent,
      model,
      'done',
      `${stage} test run - nothing written to the article`,
      null,
      tracker,
    );
    return {
      sessionId,
      stage,
      agent,
      model,
      output,
      tokensInput: tracker.tokensInput,
      tokensOutput: tracker.tokensOutput,
      costUsd: tracker.costUsd,
      llmCalls: tracker.llmCalls,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const failure = scrubbedFailure(err);
    await recordSession(article, agent, model, 'failed', `${stage} test failed`, failure.message, tracker);
    throw failure;
  }
}
