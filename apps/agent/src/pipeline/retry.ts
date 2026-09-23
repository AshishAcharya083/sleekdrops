// Retry-forward engine — re-run one stage of a run against the output the
// stage before it already stored, then let the run continue through the
// remaining stages.
//
// Neither of the two poles operators complain about: not an isolated step
// replay (the fixed stage leaves everything after it holding output derived
// from input that no longer exists), and not a rewind to the top (a failure in
// seo_review must not re-bill research and write). runStage already reads each
// stage's input from the article's own columns, so retrying forward is mostly
// bookkeeping: bump the attempt, mark where the run restarted from, and
// re-queue at that stage. The downstream columns stay in place and are
// overwritten as the run passes through them again - what makes them safe is
// that nothing may publish or approve output the run has not re-passed.
import { q } from '../db/pool.js';
import { STAGE_AGENT } from './runner.js';
import { STAGE_ORDER, type Stage } from './types.js';

/** Stages inside the write → review → edit loop, where a newer draft than the
 *  last review is the expected state rather than a stale one. */
const REVIEW_LOOP_STAGES: readonly Stage[] = [
  'research',
  'keyword',
  'angle',
  'outline',
  'write',
  'seo_review',
  'edit',
];

export const REVIEW_STALE_REASON =
  'the draft was regenerated after the last seo_review - re-run seo_review';

/** Refusal on the approval path, where the operator is being told why the
 *  button the panel disabled is disabled. */
export const REVIEW_STALE_PUBLISH_ERROR =
  'seo_review must re-run before this article can publish - the draft changed after the last review';

/** The same refusal when publish was asked for as a retry target. */
const REVIEW_STALE_RETRY_ERROR =
  'seo_review must re-run before this article can publish';

export const PUBLISHER_REVIEW_STALE_ERROR =
  'seo_review is out of date - the draft changed after the last review. Re-run seo_review before publishing.';

const stageIndex = (stage: string): number => STAGE_ORDER.indexOf(stage as Stage);

function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && stageIndex(value) !== -1;
}

export type StageParse =
  | { ok: true; stage: Stage }
  | { ok: false; error: string };

/** Read the `stage` body param of a retry/test request. The error strings are
 *  part of the API contract - the panel keys its copy off them. */
export function parseStageParam(input: unknown): StageParse {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'stage required' };
  const stage = input.trim();
  if (!isStage(stage)) return { ok: false, error: `unknown stage "${stage}"` };
  if (stage === 'done') return { ok: false, error: 'done is not a runnable stage' };
  return { ok: true, stage };
}

/**
 * The stages whose stored output was derived from input a retry has since
 * superseded: everything strictly after the stage the run restarted from that
 * the run has not reached again. A stage the run has re-passed drops out on
 * its own, which is why `stale_from_stage` never has to be cleared.
 */
export function outOfDateStages(
  staleFromStage: string | null,
  currentStage: string,
): Stage[] {
  if (!staleFromStage) return [];
  const from = stageIndex(staleFromStage);
  const current = stageIndex(currentStage);
  if (from === -1 || current === -1) return [];
  return STAGE_ORDER.filter(
    (stage, i) => i > from && i >= current && stage !== 'done',
  );
}

/**
 * The stored seo_review predates the draft it is supposed to have reviewed: a
 * writer or editor pass finished after the last completed review. Written as
 * one SQL expression so the list, the detail, the retry guards and the
 * publisher all answer the question the same way. `alias` is the `articles`
 * alias in scope.
 */
function draftNewerThanReviewSql(alias: string): string {
  return `(
    ${alias}.seo_review IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM agent_sessions w
       WHERE w.article_id = ${alias}.id
         AND w.kind = 'pipeline' AND w.status = 'done'
         AND w.agent IN ('writer', 'editor')
         AND w.ended_at > (
           SELECT max(r.ended_at) FROM agent_sessions r
            WHERE r.article_id = ${alias}.id
              AND r.kind = 'pipeline' AND r.status = 'done'
              AND r.agent = 'seo_reviewer')
    )
  )`;
}

/**
 * Whether the article as it stands is carrying a stale review. True only
 * outside the write/review/edit loop, where a newer draft is expected: past
 * that point a draft regenerated after the last review means the piece would
 * publish with a review that never saw it, which on a site whose promise is
 * independent review is not something to warn about and let through.
 */
export function reviewStaleSql(alias = 'a'): string {
  const loop = REVIEW_LOOP_STAGES.map((s) => `'${s}'`).join(', ');
  return `(${alias}.stage NOT IN (${loop}) AND ${draftNewerThanReviewSql(alias)})`;
}

/** The same question for one article, for the guards that have only an id. */
export async function isReviewStale(articleId: string): Promise<boolean> {
  const [row] = await q<{ stale: boolean }>(
    `SELECT ${reviewStaleSql('a')} AS stale FROM articles a WHERE a.id = $1`,
    [articleId],
  );
  return row?.stale === true;
}

/** The subset of an article the retry guards read. */
interface RetryTargetRow {
  id: string;
  stage: Stage;
  status: string;
  lease_held: boolean;
  /**
   * Staleness judged for a publish target rather than for the stage the row is
   * sitting on, which is why it drops reviewStaleSql()'s loop-stage exemption:
   * a run that stopped inside the write/review/edit loop after a retry
   * regenerated the draft is exactly the case the exemption exists to allow -
   * and exactly the case that must not be sent straight to the publisher.
   */
  publish_review_stale: boolean;
  /** Whether the columns the publisher reads are all there. */
  publishable: boolean;
}

export interface RequeuedArticle {
  id: string;
  stage: Stage;
  status: string;
  attempt: number;
  stale_from_stage: string | null;
}

export type RetryOutcome =
  | { ok: true; article: RequeuedArticle }
  | { ok: false; status: 404 | 409; error: string };

const MID_STAGE_RETRY_ERROR =
  'the article is mid-stage - cancel it first, then retry';
const MID_STAGE_RERUN_ERROR = 'the article is mid-stage - cancel it first';
const NOT_RETRYABLE_ERROR =
  'only a failed, timed out, cancelled or awaiting-approval article can be retried';
/**
 * Publish is the one stage whose input is not a column the operator can see
 * missing from the panel, and the one stage that pushes to the live site, so
 * asking for it on an article that never got through assemble is refused by
 * name rather than left to fail inside the publisher on a null frontmatter.
 */
const NOTHING_TO_PUBLISH_ERROR =
  'this article has no assembled draft to publish - retry from an earlier stage';

/**
 * A running article whose lease is still live is executing inside a worker
 * right now: re-queueing it would leave the in-flight stage writing over the
 * retry. Cancel expires the lease, the worker's next heartbeat finds it gone
 * and unwinds, and the row is retryable from there.
 */
async function loadTarget(id: string): Promise<RetryTargetRow | null> {
  const [row] = await q<RetryTargetRow>(
    `SELECT a.id, a.stage, a.status,
            COALESCE(a.status = 'running' AND a.lease_expires_at > now(), false) AS lease_held,
            (a.slug IS NOT NULL AND a.draft_md IS NOT NULL AND a.frontmatter IS NOT NULL)
              AS publishable,
            ${draftNewerThanReviewSql('a')} AS publish_review_stale
       FROM articles a WHERE a.id = $1`,
    [id],
  );
  return row ?? null;
}

/** Statuses a retry-forward may start from. 'running' is allowed only once the
 *  cancel path has released the lease (checked separately). */
const RETRYABLE_STATUSES = "('failed', 'timed_out', 'cancelled', 'waiting_approval')";
/** Still marked running, but holding no live lease: the worker that had it has
 *  been cancelled or reaped, so re-queueing cannot land under a live stage.
 *  Named apart from lease.ts's `LEASE_RELEASED`, which is the column set a
 *  finished run clears rather than a condition. */
const LEASE_LAPSED = "(status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))";
/** The claim and its lease, cleared: a re-queued article is nobody's, and a
 *  lease left behind from the run that stopped would describe a claim that no
 *  longer exists on a row the panel reads those columns off. */
const CLAIM_CLEARED =
  'claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL';
/**
 * The verdict of the run that stopped, cleared. It goes with the message it
 * explains: what a re-queued card carries is whatever this run produces, not
 * how the last one failed or how many attempts that took.
 */
const VERDICT_CLEARED = 'error = NULL, failure_class = NULL, stage_attempts = 0';

/**
 * Whether re-running `stage` regenerates the draft itself, which is what
 * decides the revision budget of the run that follows.
 *
 * `revision_round` only ever counts up - the edit stage increments it and
 * nothing clears it - and the reviewer force-passes a failing review once it
 * reaches `max_revision_rounds`. So an article that already spent its rounds
 * would come back from a retry with the write → review → edit loop silently
 * disabled: the first review of the new draft would be stamped "max revisions
 * reached, proceeding" on a run that has had no revisions at all. A retry at
 * or before 'write' produces a new draft, so the budget restarts with it. A
 * retry of seo_review or later is the same draft being read again, and the
 * rounds that draft already spent still count against it.
 */
const restartsTheDraft = (stage: Stage): boolean => stageIndex(stage) <= stageIndex('write');

/**
 * Re-run `stage` against the article's stored upstream columns and continue
 * forward. The upstream columns are deliberately left untouched - that is the
 * retry-forward guarantee, and the reason this costs one stage rather than a
 * whole run.
 */
export async function retryFromStage(id: string, stage: Stage): Promise<RetryOutcome> {
  const target = await loadTarget(id);
  if (!target) return { ok: false, status: 404, error: 'not found' };
  if (target.lease_held) return { ok: false, status: 409, error: MID_STAGE_RETRY_ERROR };
  if (stage === 'publish') {
    if (target.publish_review_stale) {
      return { ok: false, status: 409, error: REVIEW_STALE_RETRY_ERROR };
    }
    if (!target.publishable) {
      return { ok: false, status: 409, error: NOTHING_TO_PUBLISH_ERROR };
    }
  }

  const restartRevisions = restartsTheDraft(stage) ? 'revision_round = 0, ' : '';
  const [article] = await q<RequeuedArticle>(
    `UPDATE articles
        SET attempt = attempt + 1, stage = $2, status = 'queued', ${VERDICT_CLEARED},
            stale_from_stage = $2, ${restartRevisions}${CLAIM_CLEARED}, updated_at = now()
      WHERE id = $1 AND (status IN ${RETRYABLE_STATUSES} OR ${LEASE_LAPSED})
      RETURNING id, stage, status, attempt, stale_from_stage`,
    [id, stage],
  );
  if (!article) return { ok: false, status: 409, error: NOT_RETRYABLE_ERROR };
  return { ok: true, article };
}

/**
 * Back to the top: for when the source inputs themselves were wrong, so even
 * the research the retry-forward path preserves has to be paid for again.
 */
export async function rerunAll(id: string): Promise<RetryOutcome> {
  const target = await loadTarget(id);
  if (!target) return { ok: false, status: 404, error: 'not found' };
  if (target.lease_held) return { ok: false, status: 409, error: MID_STAGE_RERUN_ERROR };

  // The lease check is repeated in the statement itself: a worker that claims
  // the row between the two must not have its stage re-queued underneath it.
  const [article] = await q<RequeuedArticle>(
    `UPDATE articles
        SET attempt = attempt + 1, stage = 'research', status = 'queued', ${VERDICT_CLEARED},
            stale_from_stage = 'research', revision_round = 0, ${CLAIM_CLEARED},
            updated_at = now()
      WHERE id = $1 AND (status <> 'running' OR ${LEASE_LAPSED})
      RETURNING id, stage, status, attempt, stale_from_stage`,
    [id],
  );
  if (!article) return { ok: false, status: 409, error: MID_STAGE_RERUN_ERROR };
  return { ok: true, article };
}

/**
 * The cheap lever behind POST /api/articles/:id/retry: run the stage the
 * article stopped on again, without naming one.
 *
 * It re-queues through the same bookkeeping as a retry-forward rather than a
 * bare status flip, because the two have the same hazards. The claim and the
 * lease of the run that stopped go with it - a queued row holding a claim
 * nobody holds is what the panel reads as a live worker - and the pass takes
 * its own attempt number, so the sessions of the re-run are distinguishable
 * from the ones that failed. `stale_from_stage` is left alone: nothing
 * upstream of where the article already is has been superseded.
 */
export async function requeueInPlace(id: string): Promise<RetryOutcome> {
  const target = await loadTarget(id);
  if (!target) return { ok: false, status: 404, error: 'not found' };
  if (target.lease_held) return { ok: false, status: 409, error: MID_STAGE_RETRY_ERROR };

  const [article] = await q<RequeuedArticle>(
    `UPDATE articles
        SET attempt = attempt + 1, status = 'queued', ${VERDICT_CLEARED},
            ${CLAIM_CLEARED}, updated_at = now()
      WHERE id = $1 AND status IN ('failed', 'timed_out', 'cancelled')
      RETURNING id, stage, status, attempt, stale_from_stage`,
    [id],
  );
  if (!article) return { ok: false, status: 409, error: 'not retryable' };
  return { ok: true, article };
}

export type CancelOutcome =
  | { ok: true; pending: boolean }
  | { ok: false; status: 409; error: string };

/**
 * Cancel, including a running article - which used to be unreachable, leaving
 * a wedged run with no operator lever at all. Expiring the lease in the same
 * statement is what stops the in-flight stage: the worker's next conditional
 * heartbeat finds its claim gone and unwinds without writing anything, which
 * takes up to one heartbeat interval - hence `pending`.
 */
export async function cancelArticle(id: string): Promise<CancelOutcome> {
  const [row] = await q<{ was: string }>(
    `WITH prev AS (SELECT id, status FROM articles WHERE id = $1 FOR UPDATE)
     UPDATE articles a
        SET status = 'cancelled',
            lease_expires_at = CASE WHEN prev.status = 'running' THEN now()
                                    ELSE a.lease_expires_at END,
            updated_at = now()
       FROM prev
      WHERE a.id = prev.id
        AND prev.status IN ('queued', 'failed', 'timed_out', 'waiting_approval', 'running')
      RETURNING prev.status AS was`,
    [id],
  );
  if (!row) return { ok: false, status: 409, error: 'not cancellable' };
  return { ok: true, pending: row.was === 'running' };
}

/** One stage's runs against this article, newest attempt last. */
export interface AttemptRun {
  sessionId: string;
  attempt: number;
  kind: 'pipeline' | 'test';
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  model: string | null;
  summary: string | null;
  error: string | null;
}

export interface StageAttempts {
  stage: Stage;
  agent: string;
  runs: AttemptRun[];
}

/**
 * agent name → the stage it runs, for grouping sessions back onto the board.
 * Built per call rather than at module load: publisher.ts imports this module
 * for the review-stale guard and the runner imports the publisher, so reading
 * STAGE_AGENT while this module is still initialising would depend on which
 * end of that cycle was entered first.
 */
const stageOfAgent = (): Map<string, Stage> =>
  new Map(Object.entries(STAGE_AGENT).map(([stage, agent]) => [agent, stage as Stage]));

/** The agent_sessions columns the attempt history is built from. */
export interface SessionAttemptRow {
  id: string;
  agent: string;
  model: string | null;
  status: string;
  summary: string | null;
  error: string | null;
  attempt: number;
  kind: string;
  cost_usd: string | number;
  tokens_input: string | number;
  tokens_output: string | number;
  started_at: string | Date;
  ended_at: string | Date | null;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

/**
 * Attempt history grouped per stage, in pipeline order, so the panel renders
 * one article's whole history - including the retries - without deriving it.
 */
export function groupAttempts(sessions: SessionAttemptRow[]): StageAttempts[] {
  const byStage = new Map<Stage, AttemptRun[]>();
  const stageOf = stageOfAgent();
  for (const s of sessions) {
    const stage = stageOf.get(s.agent);
    if (!stage) continue;
    const startedAt = iso(s.started_at);
    const endedAt = s.ended_at ? iso(s.ended_at) : null;
    const runs = byStage.get(stage) ?? [];
    runs.push({
      sessionId: s.id,
      attempt: Number(s.attempt),
      kind: s.kind === 'test' ? 'test' : 'pipeline',
      status: s.status,
      startedAt,
      endedAt,
      durationMs: endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null,
      costUsd: Number(s.cost_usd),
      tokensInput: Number(s.tokens_input),
      tokensOutput: Number(s.tokens_output),
      model: s.model,
      summary: s.summary,
      error: s.error,
    });
    byStage.set(stage, runs);
  }
  return STAGE_ORDER.filter((stage) => byStage.has(stage)).map((stage) => ({
    stage,
    agent: STAGE_AGENT[stage as Exclude<Stage, 'done'>],
    runs: byStage
      .get(stage)!
      .sort((x, y) => x.attempt - y.attempt || x.startedAt.localeCompare(y.startedAt)),
  }));
}
