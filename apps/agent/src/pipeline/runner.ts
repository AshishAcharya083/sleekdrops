// Stage runner — executes one pipeline stage for one claimed article,
// records an agent_session (model, tokens, cost, duration), and routes the
// article to its next stage. Verdict-driven, bounded revision loop —
// a light version of devteam-platform's card lane pattern.
import { MONETISED_INTENTS } from '../content/contract.js';
import { withDiscoveredProducts } from '../content/evidence.js';
import { describeShapeSelection } from '../content/shapes.js';
import { getSetting, q } from '../db/pool.js';
import { withDeadline } from '../lib/deadline.js';
import { createLogger } from '../lib/log.js';
import { describeLlmCall, newLlmCallTrace, withLlmCallTrace } from '../llm/callTrace.js';
import {
  claudeConfigured,
  CLAUDE_NOT_CONFIGURED,
  defaultClaudeModel,
  defaultGeminiModel,
  isClaudeModel,
  llmSettings,
  UsageTracker,
} from '../llm/index.js';
import { runAngleEditor } from '../agents/angleEditor.js';
import { runAssembler } from '../agents/assembler.js';
import { runEditor } from '../agents/editor.js';
import { runImageAgent } from '../agents/imageAgent.js';
import { runKeywordStrategist } from '../agents/keywordStrategist.js';
import { runOutliner } from '../agents/outliner.js';
import { runPublisher } from '../agents/publisher.js';
import { runProductDiscovery, runResearcher } from '../agents/researcher.js';
import { runSeoReviewer } from '../agents/seoReviewer.js';
import { runWriter } from '../agents/writer.js';
import { LEASE_RELEASED, renewLease, startHeartbeat } from './lease.js';
import { scrubSecrets, stageBudgetSeconds, stageTimeoutError } from './stageTimeout.js';
import { StageTimeoutError } from './types.js';
import type { ArticleRow, SeoReview, SessionStatus, Stage, TopicRow } from './types.js';

const log = createLogger('pipeline');

/** The agent that runs each stage. A stage missing here has no named session. */
export const STAGE_AGENT: Record<Exclude<Stage, 'done'>, string> = {
  research: 'researcher',
  keyword: 'keyword_strategist',
  angle: 'angle_editor',
  outline: 'outliner',
  write: 'writer',
  seo_review: 'seo_reviewer',
  edit: 'editor',
  assemble: 'assembler',
  image: 'image_agent',
  publish: 'publisher',
};

/**
 * Per-stage wall-clock budget, in seconds, for the stages that genuinely
 * differ from AGENT_RUN_TIMEOUT_SECONDS. Deliberately part of the stage
 * definition - next to the agent that runs it - and deliberately not a
 * database row or a Settings field: it is a property of the stage, decided
 * with its prompt and its model, not a knob an operator tunes per run. Every
 * value here is still capped by MAX_STAGE_TIMEOUT_SECONDS.
 *
 * Empty means every stage runs on the configured budget, which is the state
 * today: the longest legitimate run measured is an seo_review at roughly 90
 * minutes, and that is a stage to make faster, not one to give more time.
 */
export const STAGE_TIMEOUT_SECONDS: Partial<Record<Exclude<Stage, 'done'>, number>> = {};

/** Stages that run deterministic code — no LLM chat, no model to pick. */
export const NO_LLM_AGENTS = new Set(['assembler', 'publisher']);

/**
 * Every agent that runs a prompt. All of them follow the admin engine toggle,
 * which defaults to Claude (Opus 5).
 *
 * This started as writer + editor, then grew to the six article stages, and
 * now includes the topic scout as well. The reasoning is the same each time: a
 * stage is only as good as the one feeding it. A weaker scout picks the topics
 * everything downstream then spends its budget on, so leaving it on the cheap
 * model saved the least valuable tokens in the pipeline.
 */
export const ENGINE_AGENTS = new Set([
  'topic_scout',
  'researcher',
  'keyword_strategist',
  'angle_editor',
  'outliner',
  'writer',
  'seo_reviewer',
  'editor',
]);

/**
 * Pinned to Gemini whatever the toggle says. The image agent vision-checks
 * candidate photos and generates a hero when none is usable — that is a
 * capability boundary, not a preference, so it is not offered as a choice in
 * the admin panel either.
 */
const GEMINI_ONLY_AGENTS = new Set(['image_agent']);

export async function modelFor(agent: string): Promise<string> {
  const settings = await llmSettings();
  const overrides = await getSetting<Record<string, string>>('models', {});
  if (GEMINI_ONLY_AGENTS.has(agent)) return defaultGeminiModel(settings);

  const pick =
    overrides[agent] ||
    (ENGINE_AGENTS.has(agent) && (settings.prose_engine ?? 'claude') === 'claude'
      ? defaultClaudeModel(settings)
      : defaultGeminiModel(settings));

  // A Claude pick without a credential used to degrade to Gemini and log a
  // warning nobody reads — so the panel said Opus 5 while every session row
  // said gemini-2.5-flash, and the articles came out of the cheap model
  // unnoticed. Refusing to start is the honest failure: it names the missing
  // credential on the article, in the pipeline, where an operator will see it.
  if (isClaudeModel(pick) && !(await claudeConfigured())) {
    throw new Error(`${agent} is set to run on ${pick}. ${CLAUDE_NOT_CONFIGURED}`);
  }
  return pick;
}

/**
 * The axes in the order an operator reads them: the current set first, the
 * pre-rebuild ones after. Needed because JSONB does not preserve key order - a
 * review read back out of the column comes out sorted by key length - and
 * because a review written before the restructure still has to render its own
 * keys instead of five "undefined"s.
 */
const DIMENSION_ORDER = [
  'evidence',
  'position',
  'structure',
  'citability',
  'links',
  'seo',
  'geo',
  'voice',
  'eeat',
];

const dimensionRank = (name: string): number => {
  const at = DIMENSION_ORDER.indexOf(name);
  return at === -1 ? DIMENSION_ORDER.length : at;
};

/** The seo_review session line an operator reads in the panel. */
export function summariseReview(review: SeoReview): string {
  const dims = review.dimensions
    ? ` [${Object.entries(review.dimensions)
        .sort(([a], [b]) => dimensionRank(a) - dimensionRank(b) || a.localeCompare(b))
        .map(([name, value]) => `${name} ${value}`)
        .join(' · ')}]`
    : '';
  const slop = review.slop
    ? `, slop scan ${review.slop.score}/100 (${review.slop.findings} finding(s))`
    : '';
  const delta = review.competitorDelta
    ? `, vs top ${review.competitorDelta.comparedWith.length}: ${review.competitorDelta.verdict}`
    : '';
  const claims = review.claimAudit
    ? `, ${review.claimAudit.unsupported}/${review.claimAudit.checked} specifics unsupported`
    : '';
  return `score ${review.score}/100${dims}, ${review.pass ? 'PASS' : 'FAIL'} (${review.issues.length} issues)${delta}${claims}${slop}${
    review.forcedThrough ? ' - max revisions reached, proceeding' : ''
  }`;
}

async function updateArticle(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q(`UPDATE articles SET ${sets}, updated_at = now() WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k]),
  ]);
}

/**
 * The write that ends this run, applied only while the run still owns the
 * article. A stage cannot be cancelled once it is running, so a run that was
 * reaped and then retried can still be in flight when the retry's own claim
 * starts - and the routing decision of a run nobody is waiting for must not
 * land on top of the one that replaced it. `attempt` is bumped by the claim,
 * so it is exactly the identity of the run that took it.
 */
async function finishArticle(article: ArticleRow, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const applied = await q(
    `UPDATE articles SET ${sets}, updated_at = now() WHERE id = $1 AND attempt = $2 RETURNING id`,
    [article.id, article.attempt ?? 0, ...keys.map((k) => fields[k])],
  );
  if (applied.length === 0) {
    log.warn('stage result dropped: the article was claimed again while it ran', {
      article_id: article.id,
      stage: article.stage,
      attempt: article.attempt ?? 0,
    });
  }
}

/** Ensure the brief's slug doesn't collide with another article. */
async function uniqueSlug(articleId: string, want: string): Promise<string> {
  for (let n = 0; n < 20; n++) {
    const candidate = n === 0 ? want : `${want}-${n + 1}`;
    const clash = await q('SELECT 1 FROM articles WHERE slug = $1 AND id <> $2', [
      candidate,
      articleId,
    ]);
    if (clash.length === 0) return candidate;
  }
  return `${want}-${articleId.slice(0, 8)}`;
}

/** Where a finished stage sends the article, and the line its session carries. */
export interface StageOutcome {
  next: { stage: Stage; status: string };
  summary: string;
}

/**
 * The body of one stage: everything between "the article is claimed" and "the
 * stage has an answer". Separate from runStage because runStage is what is
 * raced against the budget, and the thing being raced has to be a value it can
 * hold - and because injecting one is how the timeout path is driven in a test
 * without a live model.
 */
export type StageExecutor = (
  article: ArticleRow,
  stage: Exclude<Stage, 'done'>,
  model: string | null,
  tracker: UsageTracker,
) => Promise<StageOutcome>;

export const executeStage: StageExecutor = async (article, stage, model, tracker) => {
  let next: { stage: Stage; status: string } = { stage: 'done', status: 'done' };
  let summary = '';

  switch (stage) {
    case 'research': {
      const topic = article.topic_id
        ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
        : null;
      const dossier = await runResearcher(article, topic, model!, tracker);
      await updateArticle(article.id, { research: JSON.stringify(dossier) });
      summary = `${dossier.facts?.length ?? 0} facts, ${dossier.products?.length ?? 0} products, primary keyword "${dossier.keywords?.primary}"`;
      next = { stage: 'keyword', status: 'queued' };
      break;
    }
    case 'keyword': {
      const topic = article.topic_id
        ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
        : null;
      const plan = await runKeywordStrategist(article, topic, model!, tracker);
      await updateArticle(article.id, { keyword_plan: JSON.stringify(plan) });
      // Earliest point at which "this piece has nothing to link" is knowable:
      // the dossier is built, and the SERP read has just named the intent.
      // Deal with it here rather than at assemble - outline, write, review
      // and up to two edit rounds all run on Opus 5 in between.
      //
      // A missing product list is a narrow, recoverable fault, so it gets a
      // discovery pass before the card is failed: the research stage filed
      // its evidence and skipped the contenders, and one focused search is
      // what it takes to fill that in. Only an empty result is terminal.
      let discoveryNote = '';
      if ((article.research?.products?.length ?? 0) === 0 && MONETISED_INTENTS.has(plan.intent)) {
        const products = await runProductDiscovery(
          article,
          topic,
          plan.primaryKeyword,
          model!,
          tracker,
        );
        if (products.length === 0) {
          throw new Error(
            `the dossier has no products and a discovery pass for "${plan.primaryKeyword}" found ` +
              `none either, but the SERP read says this is a ${plan.intent} query - there would be ` +
              `nothing on the page for a reader to click. Re-run research (a "${article.post_type}" ` +
              `is not required to find products, so it did not) or add them to the topic brief by hand.`,
          );
        }
        await updateArticle(article.id, {
          research: JSON.stringify(withDiscoveredProducts(article.research, products)),
        });
        discoveryNote = `, ${products.length} product(s) recovered by a discovery pass`;
      }
      summary = `"${plan.primaryKeyword}" — ${plan.intent}, ${plan.difficulty} difficulty, ${plan.zeroClickRisk} zero-click risk, ${plan.wordCountTarget} words, ${plan.contentGaps.length} gap(s) to exploit${discoveryNote}`;
      next = { stage: 'angle', status: 'queued' };
      break;
    }
    case 'angle': {
      const topic = article.topic_id
        ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
        : null;
      const angle = await runAngleEditor(article, topic, model!, tracker);
      await updateArticle(article.id, { editorial_angle: JSON.stringify(angle) });
      summary = angle.defensible
        ? `"${angle.thesis}" - ${angle.shape} shape, ${angle.informationGain.length} claim(s) the top results miss, ${angle.byline} beat`
        : `no defensible take recorded (${angle.weakness}) - ${angle.shape} shape, ${angle.byline} beat`;
      next = { stage: 'outline', status: 'queued' };
      break;
    }
    case 'outline': {
      const brief = await runOutliner(article, model!, tracker);
      brief.slug = await uniqueSlug(article.id, brief.slug);
      // The shape goes in its own column as well as inside the brief: the
      // brief is what carries it into the writer and reviewer prompts, the
      // column is the record of the decision an operator can see and query.
      // Both are written here so they can never disagree.
      const shape = brief.structureShape ?? null;
      await updateArticle(article.id, {
        outline: JSON.stringify(brief),
        structure_shape: shape ? JSON.stringify(shape) : null,
        slug: brief.slug,
        title: brief.seoTitle,
      });
      summary = `"${brief.seoTitle}" — ${shape ? `${describeShapeSelection(shape)}, ` : ''}${brief.sections?.length ?? 0} sections, target ${brief.wordCountTarget} words`;
      next = { stage: 'write', status: 'queued' };
      break;
    }
    case 'write': {
      const topic = article.topic_id
        ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
        : null;
      const draft = await runWriter(article, topic, model!, tracker);
      await updateArticle(article.id, { draft_md: draft });
      summary = `draft written (${draft.split(/\s+/).length} words)`;
      next = { stage: 'seo_review', status: 'queued' };
      break;
    }
    case 'seo_review': {
      const review = await runSeoReviewer(article, model!, tracker);
      const maxRounds = await getSetting<number>('max_revision_rounds', 2);
      if (!review.pass && article.revision_round >= maxRounds) {
        review.forcedThrough = true;
      }
      await updateArticle(article.id, { seo_review: JSON.stringify(review) });
      summary = summariseReview(review);
      next =
        review.pass || review.forcedThrough
          ? { stage: 'assemble', status: 'queued' }
          : { stage: 'edit', status: 'queued' };
      break;
    }
    case 'edit': {
      const revised = await runEditor(article, model!, tracker);
      await updateArticle(article.id, {
        draft_md: revised,
        revision_round: article.revision_round + 1,
        // Admin feedback is consumed by exactly one edit pass.
        feedback: null,
      });
      summary = `revision round ${article.revision_round + 1} applied${article.feedback ? ' (incl. admin feedback)' : ''}`;
      next = { stage: 'seo_review', status: 'queued' };
      break;
    }
    case 'assemble': {
      const assembled = await runAssembler(article);
      await updateArticle(article.id, {
        draft_md: assembled.body,
        frontmatter: JSON.stringify(assembled.frontmatter),
        affiliate_links: JSON.stringify(assembled.affiliateLinks),
      });
      summary = `frontmatter + ${assembled.affiliateLinks.length} affiliate link(s) validated${
        assembled.healedSlugs.length > 0
          ? ` (${assembled.healedSlugs.length} healed from the draft: ${assembled.healedSlugs.join(', ')})`
          : ''
      }${
        assembled.droppedSlugs.length > 0
          ? `; stripped unlinkable: ${assembled.droppedSlugs.join(', ')}`
          : ''
      }`;
      next = { stage: 'image', status: 'queued' };
      break;
    }
    case 'image': {
      const existing = article.frontmatter ?? {};
      if (article.hero_image_url) {
        // The operator dropped a file in the admin panel; the assembler has
        // already stamped it into frontmatter. Searching would be waste.
        summary = 'operator-supplied hero image — image search skipped';
      } else if (existing.heroImage) {
        summary = 'hero image already set — keeping it';
      } else {
        const image = await runImageAgent(article, model!);
        if (image.heroImage) {
          await updateArticle(article.id, {
            frontmatter: JSON.stringify({
              ...existing,
              heroImage: image.heroImage,
              heroAlt: image.heroAlt ?? undefined,
            }),
          });
        }
        summary = image.summary;
      }
      const publishMode = await getSetting<string>('publish_mode', 'approval');
      next =
        publishMode === 'approval'
          ? { stage: 'publish', status: 'waiting_approval' }
          : { stage: 'publish', status: 'queued' };
      break;
    }
    case 'publish': {
      const result = await runPublisher(article);
      await updateArticle(article.id, { published_at: new Date().toISOString() });
      if (article.topic_id) {
        await q("UPDATE topics SET status = 'approved', updated_at = now() WHERE id = $1", [
          article.topic_id,
        ]);
      }
      summary = `${result.slug} → D1 as '${result.d1Status}'${result.dispatched ? ', site rebuild dispatched' : ''}`;
      next = { stage: 'done', status: 'done' };
      break;
    }
  }

  return { next, summary };
};

export async function runStage(
  article: ArticleRow,
  execute: StageExecutor = executeStage,
): Promise<void> {
  const stage = article.stage;
  if (stage === 'done') return;
  const agent = STAGE_AGENT[stage];
  const budgetSeconds = stageBudgetSeconds(STAGE_TIMEOUT_SECONDS[stage]);

  // Picking the model can fail now (a Claude stage with no credential), and it
  // happens before there is a session row to fail. Record one anyway: an
  // article left 'running' would be reaped as a timeout it never got to have,
  // with nothing on screen to say why.
  let model: string | null;
  try {
    model = NO_LLM_AGENTS.has(agent) ? null : await modelFor(agent);
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    await q(
      `INSERT INTO agent_sessions (article_id, agent, status, summary, error, attempt, ended_at)
       VALUES ($1, $2, 'failed', $3, $4, $5, now())`,
      [article.id, agent, `${stage} could not start`, message, article.attempt ?? 0],
    );
    await finishArticle(article, {
      status: 'failed',
      error: message,
      ...LEASE_RELEASED,
    });
    console.error(`[pipeline] ${article.id} ${stage} could not start: ${message}`);
    return;
  }

  const tracker = new UsageTracker();

  const [session] = await q<{ id: string }>(
    `INSERT INTO agent_sessions (article_id, agent, model, attempt) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [article.id, agent, model, article.attempt ?? 0],
  );

  const finishSession = async (status: SessionStatus, summary: string, error?: string) => {
    await q(
      `UPDATE agent_sessions SET status = $2, summary = $3, error = $4,
         tokens_input = $5, tokens_output = $6, cost_usd = $7, llm_calls = $8,
         model = COALESCE($9, model), ended_at = now()
       WHERE id = $1`,
      [
        session.id,
        status,
        summary,
        error ?? null,
        tracker.tokensInput,
        tracker.tokensOutput,
        tracker.costUsd,
        tracker.llmCalls,
        tracker.models.size > 0 ? [...tracker.models].join(',') : null,
      ],
    );
  };

  // The stage runs under a wall-clock budget and holds its lease open while it
  // does: the budget is what stops a stage that has stopped making progress,
  // the lease is what lets another process see that this one stopped too.
  const startedAt = Date.now();
  const trace = newLlmCallTrace();
  // Take the lease before the first await of the stage itself, so a run that
  // reached here by any route - a worker claim, a retry running it inline - is
  // covered by the reaper rather than only from the first heartbeat onwards.
  await renewLease(article.id);
  const stopHeartbeat = startHeartbeat(article.id, (err) =>
    log.warn('lease renewal failed', { article_id: article.id, stage, error: err }),
  );

  try {
    const { next, summary } = await withDeadline(
      budgetSeconds * 1000,
      () => withLlmCallTrace(trace, () => execute(article, stage, model, tracker)),
      () =>
        stageTimeoutError({
          agent,
          stage,
          budgetSeconds,
          elapsedSeconds: (Date.now() - startedAt) / 1000,
          lastCall: describeLlmCall(trace.last),
          cause: 'budget',
        }),
    );
    await finishSession('done', summary);
    await finishArticle(article, {
      stage: next.stage,
      status: next.status,
      error: null,
      ...LEASE_RELEASED,
    });
    console.log(`[pipeline] ${article.id} ${stage} done → ${next.stage}/${next.status}: ${summary}`);
  } catch (err) {
    if (err instanceof StageTimeoutError) {
      await finishSession('timed_out', `${stage} timed out`, err.message);
      // The article keeps its stage and everything the run had written: a
      // half-finished draft is the operator's to look at and retry from, not
      // something to throw away because the run that produced it was stopped.
      await finishArticle(article, {
        status: 'timed_out',
        error: err.message,
        ...LEASE_RELEASED,
      });
      log.warn('stage timed out', {
        article_id: article.id,
        stage,
        agent,
        cause: err.cause,
        budget_seconds: err.budgetSeconds,
        elapsed_seconds: Math.round(err.elapsedSeconds),
        last_llm_call: err.lastCall || null,
      });
      return;
    }
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    await finishSession('failed', `${stage} failed`, message);
    await finishArticle(article, {
      status: 'failed',
      error: message,
      ...LEASE_RELEASED,
    });
    console.error(`[pipeline] ${article.id} ${stage} FAILED: ${message}`);
  } finally {
    stopHeartbeat();
  }
}
