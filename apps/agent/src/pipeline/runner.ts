// Stage runner — executes one pipeline stage for one claimed article,
// records an agent_session (model, tokens, cost, duration), and routes the
// article to its next stage. Verdict-driven, bounded revision loop —
// a light version of devteam-platform's card lane pattern.
import { MONETISED_INTENTS } from '../content/contract.js';
import { withDiscoveredProducts } from '../content/evidence.js';
import { describeShapeSelection } from '../content/shapes.js';
import { offersForArticle } from '../db/offers.js';
import { getSetting, q } from '../db/pool.js';
import { describeEnqueue, enqueuePublishedArticle } from '../distribution/queue.js';
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
import { stageBudgetSeconds } from './budgets.js';
import {
  LEASE_LOST_MESSAGE,
  LEASE_RELEASED,
  LeaseLostError,
  renewLease,
  startHeartbeat,
  updateClaimed,
} from './lease.js';
import { scrubSecrets, stageTimeoutError } from './stageTimeout.js';
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
 * The other half of a stage's definition: how long it may run. It belongs
 * beside STAGE_AGENT and is re-exported here to be read beside it, but the
 * literal lives in budgets.ts so that resolving a budget - which the admin API
 * does on every article request - costs an import of configuration rather than
 * an import of every agent in this file.
 */
export { STAGE_TIMEOUT_SECONDS } from './budgets.js';

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

/**
 * A stage body's own output - a dossier, a draft, an assembled frontmatter.
 * Lands while the run still owns the article, which is what keeps the partial
 * output of a stage that is later stopped: everything written before the
 * budget expired was written under a live claim. Every write a stage makes
 * goes through the claim guard, not just the one that ends it - `withDeadline`
 * settles the promise runStage is waiting on, it does not stop the work behind
 * it, so an abandoned stage runs on with more writes in it.
 *
 * A write that finds the claim gone is dropped, and ends the stage the way
 * losing the lease does. Dropping it alone would not be enough - the body
 * would carry on to its next write, and to the model calls between them - and
 * the run that took the article over has already recorded what became of it.
 *
 * Exported only so a test can drive the guard against a real row: every stage
 * body that uses it is in this file.
 */
export async function updateArticle(
  article: ArticleRow,
  fields: Record<string, unknown>,
): Promise<void> {
  if (await updateClaimed(article, fields)) return;
  log.warn('stage output dropped: the article moved on while the stage ran', {
    article_id: article.id,
    stage: article.stage,
    claimed_by: article.claimed_by,
    columns: Object.keys(fields),
  });
  throw new LeaseLostError();
}

/**
 * The write that ends this run. Same guard, but a drop is only logged: the
 * routing decision of a run nobody is waiting for must not land on top of the
 * state that replaced it, and by this point there is no stage left to stop.
 */
async function finishArticle(article: ArticleRow, fields: Record<string, unknown>): Promise<void> {
  if (await updateClaimed(article, fields)) return;
  log.warn('stage result dropped: the article moved on while the stage ran', {
    article_id: article.id,
    stage: article.stage,
    claimed_by: article.claimed_by,
  });
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
      await updateArticle(article, { research: JSON.stringify(dossier) });
      summary = `${dossier.facts?.length ?? 0} facts, ${dossier.products?.length ?? 0} products, primary keyword "${dossier.keywords?.primary}"`;
      next = { stage: 'keyword', status: 'queued' };
      break;
    }
    case 'keyword': {
      const topic = article.topic_id
        ? (await q<TopicRow>('SELECT * FROM topics WHERE id = $1', [article.topic_id]))[0] ?? null
        : null;
      const plan = await runKeywordStrategist(article, topic, model!, tracker);
      await updateArticle(article, { keyword_plan: JSON.stringify(plan) });
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
        await updateArticle(article, {
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
      await updateArticle(article, { editorial_angle: JSON.stringify(angle) });
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
      await updateArticle(article, {
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
      await updateArticle(article, { draft_md: draft });
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
      await updateArticle(article, { seo_review: JSON.stringify(review) });
      summary = summariseReview(review);
      next =
        review.pass || review.forcedThrough
          ? { stage: 'assemble', status: 'queued' }
          : { stage: 'edit', status: 'queued' };
      break;
    }
    case 'edit': {
      const revised = await runEditor(article, model!, tracker);
      await updateArticle(article, {
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
      // The offers an editor attached are read here, not inside the
      // assembler: the assembler stays a pure function of the card it is
      // handed, which is what lets it be driven straight from a fixture.
      const offers = await offersForArticle(article.id);
      const assembled = await runAssembler(article, offers);
      await updateArticle(article, {
        draft_md: assembled.body,
        frontmatter: JSON.stringify(assembled.frontmatter),
        affiliate_links: JSON.stringify(assembled.affiliateLinks),
      });
      summary = `frontmatter + ${assembled.affiliateLinks.length} affiliate link(s) validated${
        assembled.offerSlugs.length > 0
          ? ` (${assembled.offerSlugs.length} from attached offer(s): ${assembled.offerSlugs.join(', ')})`
          : ''
      }${
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
      // Every path that settles a hero also records where it came from.
      // Provenance is a rights fact, not a note: distribution may upload an
      // image we generated to a social network and may not upload a
      // photograph the agent found on someone else's site, and that decision
      // cannot be made by parsing this stage's summary line.
      if (article.hero_image_url) {
        // The operator dropped a file in the admin panel; the assembler has
        // already stamped it into frontmatter. Searching would be waste.
        await updateArticle(article, { hero_image_source: 'operator' });
        summary = 'operator-supplied hero image — image search skipped';
      } else if (existing.heroImage) {
        summary = 'hero image already set — keeping it';
      } else {
        const image = await runImageAgent(article, model!);
        if (image.heroImage) {
          await updateArticle(article, {
            frontmatter: JSON.stringify({
              ...existing,
              heroImage: image.heroImage,
              heroAlt: image.heroAlt ?? undefined,
            }),
            hero_image_source: image.source,
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
      await updateArticle(article, { published_at: new Date().toISOString() });
      if (article.topic_id) {
        await q("UPDATE topics SET status = 'approved', updated_at = now() WHERE id = $1", [
          article.topic_id,
        ]);
      }
      // Social posting is enqueued, never sent from here. This stage is
      // re-entered by a republish, by a retry-from-stage and by the editorial
      // feedback loop, so a send would fire again for the same slug every
      // time; the queue is unique on (slug, channel) and every later pass is a
      // no-op. A draft enqueues nothing, on the same reading of the publish
      // mode that keeps `dispatchContentUpdated` from firing for one.
      const distribution = await enqueuePublishedArticle(article, { d1Status: result.d1Status });
      summary = `${result.slug} → D1 as '${result.d1Status}'${result.dispatched ? ', site rebuild dispatched' : ''}; ${describeEnqueue(distribution)}`;
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
  const budgetSeconds = stageBudgetSeconds(stage);

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
      [article.id, agent, `${stage} could not start`, message, article.attempt ?? 1],
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
    [article.id, agent, model, article.attempt ?? 1],
  );

  // Only while this run's session is still open. A reaper or a boot recovery
  // that already closed it has written what actually became of the run, and
  // this process - which by then is the one that was reaped - is in no
  // position to correct them.
  const finishSession = async (status: SessionStatus, summary: string, error?: string) => {
    await q(
      `UPDATE agent_sessions SET status = $2, summary = $3, error = $4,
         tokens_input = $5, tokens_output = $6, cost_usd = $7, llm_calls = $8,
         model = COALESCE($9, model), ended_at = now()
       WHERE id = $1 AND status = 'running'`,
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
  // A run that reaches here without a claim (an inline invocation, a test
  // harness) holds no lease and therefore has none to lose; everything the
  // worker starts is claimed, which is the path this guards.
  const holder = article.claimed_by;
  let stopHeartbeat = () => {};
  // Losing the lease ends the stage the same way its budget running out does:
  // by settling the promise runStage is waiting on. Nothing can cancel the
  // work itself - a JavaScript promise has no cancel - so what matters is that
  // this run stops writing, and that is the claim guard on every article write
  // rather than this race: the body abandoned here runs on, and its next
  // updateArticle is where it finds out the article is no longer its own.
  let abandon: (reason: Error) => void = () => {};
  const leaseLost = new Promise<never>((_, reject) => {
    abandon = reject;
  });
  leaseLost.catch(() => {
    /* rejected after the race has been decided is nobody's failure to handle */
  });

  try {
    // Take the lease before the first await of the stage itself, so the run is
    // covered by the reaper rather than only from the first heartbeat onwards
    // - and so a claim that is already gone stops here rather than at the end.
    if (holder) {
      if (!(await renewLease(article.id, holder))) throw new LeaseLostError();
      stopHeartbeat = startHeartbeat(article.id, holder, {
        onLost: () => abandon(new LeaseLostError()),
        onError: (err) =>
          log.warn('lease renewal failed', { article_id: article.id, stage, error: err }),
      });
    }

    const { next, summary } = await withDeadline(
      budgetSeconds * 1000,
      () =>
        Promise.race([
          leaseLost,
          withLlmCallTrace(trace, () => execute(article, stage, model, tracker)),
        ]),
      () =>
        stageTimeoutError({
          agent,
          stage,
          budgetSeconds,
          elapsedSeconds: (Date.now() - startedAt) / 1000,
          lastCall: describeLlmCall(trace.last),
          timeoutCause: 'budget',
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
    if (err instanceof LeaseLostError) {
      // Whoever took the article away from this run has already written what
      // happened to it - reaped to 'timed_out', cancelled from the panel, or
      // claimed again. Touching an article column here is how that outcome
      // gets overwritten, so this run records only its own session.
      await finishSession('failed', `${stage} stopped`, LEASE_LOST_MESSAGE);
      log.warn('stage stopped: lease lost', {
        article_id: article.id,
        stage,
        agent,
        claimed_by: holder,
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      });
      return;
    }
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
        cause: err.timeoutCause,
        budget_seconds: err.budgetSeconds,
        elapsed_seconds: Math.round(err.elapsedSeconds),
        last_llm_call: err.lastCall,
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
