/**
 * Stages, budgets and the elapsed-time threshold scale - the panel's share of
 * the contract it has with the agent: the fixed stage order, the two
 * boundaries that decide whether a run is slow or stuck, the fixed operator
 * copy, the bookkeeping that turns a flat session list into per-stage attempt
 * history, and the reader for what an isolated test run comes back as.
 *
 * Pure and dependency-free on purpose, so it is unit-tested in isolation the
 * way scrub.ts is (see stage-thresholds.test.ts). api.ts re-exports all of it.
 */

/** The slice of an agent session this module reasons about. */
export interface StageSession {
  /** Null on scout runs and on rows written before attempts were tracked. */
  stage?: string | null;
  /** Always present: the only column that has named the work since 001_init. */
  agent?: string;
  attempt?: number;
  kind?: string;
  status: string;
  started_at: string;
}

/** The stage execution budgets, as read-only server configuration. */
export interface StageBudgets {
  default_seconds?: number;
  /** Only the stages that override the default carry an entry. */
  per_stage?: Record<string, number>;
}

/**
 * The pipeline's stage order. Hardcoded here the same way the board lanes in
 * pages/Pipeline.tsx are: it is the panel's own reading order for a run, and
 * what decides which stages sit downstream of a retry.
 */
export const STAGE_ORDER = [
  'research',
  'keyword',
  'angle',
  'outline',
  'write',
  'seo_review',
  'edit',
  'assemble',
  'image',
  'publish',
  'done',
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

/**
 * Which agent runs which stage, mirroring STAGE_AGENT in the agent's runner
 * the same way STAGE_ORDER above mirrors its stage list.
 *
 * `agent_sessions` has carried an `agent` column since the first migration and
 * carries no `stage` column, so this is how a session is placed on the board -
 * the agent derives its own attempt grouping from exactly this map. It is a
 * lookup of a fixed name, not a guess: an agent that is not in it (topic_scout,
 * or anything added later) stays unplaced rather than landing on a stage.
 */
export const AGENT_STAGE: Record<string, Stage> = {
  researcher: 'research',
  keyword_strategist: 'keyword',
  angle_editor: 'angle',
  outliner: 'outline',
  writer: 'write',
  seo_reviewer: 'seo_review',
  editor: 'edit',
  assembler: 'assemble',
  image_agent: 'image',
  publisher: 'publish',
};

/**
 * The same map read the other way: which agent a stage runs under. A claimed
 * article names its stage, not its agent, so this is how a run that has no
 * session on the payload is still reported by the thing operating it.
 */
export const STAGE_AGENT: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_STAGE).map(([agent, stage]) => [stage, agent]),
);

/**
 * The stage one session ran: the reported field when the agent sends one, else
 * the stage that session's agent owns. Null means genuinely unplaceable - a
 * topic search, or an agent this panel does not know.
 */
export const sessionStage = (session: StageSession): string | null =>
  session.stage ?? (session.agent ? (AGENT_STAGE[session.agent] ?? null) : null);

/** Human labels for the stages, for prose that has to name them. */
export const STAGE_LABELS: Record<string, string> = {
  research: 'research',
  keyword: 'keyword plan',
  angle: 'editorial angle',
  outline: 'outline',
  write: 'write',
  seo_review: 'SEO review',
  edit: 'edit',
  assemble: 'assemble',
  image: 'hero image',
  publish: 'publish',
  done: 'done',
};

/** Last-resort stage budget, used when the agent reports none at all. */
export const DEFAULT_STAGE_BUDGET_SECONDS = 3600;

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * The budget one stage runs under: its own override, else the configured
 * default, else the built-in hour. The panel never derives a budget of its
 * own - this only picks between the values the agent reported.
 */
export function stageBudgetSeconds(
  stage: string | null | undefined,
  budgets?: StageBudgets | null,
): number {
  const override = stage ? positive(budgets?.per_stage?.[stage]) : null;
  return override ?? positive(budgets?.default_seconds) ?? DEFAULT_STAGE_BUDGET_SECONDS;
}

/**
 * The budget one session ran under, or null when it sits on no stage at all -
 * a topic search has its own lease, not a stage budget, and borrowing the
 * stage default for it would print a limit that run was never under.
 */
export const sessionBudgetSeconds = (
  session: StageSession,
  budgets?: StageBudgets | null,
): number | null => {
  const stage = sessionStage(session);
  return stage ? stageBudgetSeconds(stage, budgets) : null;
};

/** Seconds as the panel prints an elapsed time: `42s`, or `2702m 12s`. */
export const fmtSeconds = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Where an elapsed time sits against its stage budget. */
export type ElapsedBand = 'normal' | 'warn' | 'over';

/**
 * The threshold scale, shared with the agent so the Overview surface and the
 * cell styling can never disagree: half the budget is the soft bound, the
 * budget itself is the hard one, and a run the budget already stopped is over
 * however long it actually ran.
 */
export function elapsedBand(
  elapsedSeconds: number,
  budgetSeconds: number,
  status?: string | null,
): ElapsedBand {
  if (status === 'timed_out') return 'over';
  const budget = positive(budgetSeconds) ?? DEFAULT_STAGE_BUDGET_SECONDS;
  if (elapsedSeconds >= budget) return 'over';
  if (elapsedSeconds >= budget * 0.5) return 'warn';
  return 'normal';
}

/** Budget in whole minutes, as every operator sentence about it prints it. */
export const budgetMinutes = (budgetSeconds: number): number => Math.round(budgetSeconds / 60);

/** The one sentence a stopped run explains itself with. */
export const timedOutSentence = (budgetSeconds: number): string =>
  `Stopped after ${budgetMinutes(budgetSeconds)} minutes (the limit for this agent). ` +
  'Any partial output has been saved as a draft.';

/** The budget as read-only text. It is configuration, not a panel field. */
export const stageBudgetLine = (budgetSeconds: number): string =>
  `Stage budget: ${budgetMinutes(budgetSeconds)} minutes - set on the agent, not editable here.`;

/** Banner on an article whose draft outran its review. */
export const REVIEW_STALE_BANNER =
  'This draft changed after its last SEO review. Re-run SEO review before publishing.';

/** Why the approve control is disabled - the sentence the API's 409 carries. */
export const REVIEW_STALE_REASON =
  'seo_review must re-run before publish - the draft changed after the last review';

/**
 * Stages an isolated test run can cover. The one thing `publish` does is write
 * to the live site, so the "writes nothing" this control promises cannot hold
 * for it, and `done` runs no agent at all.
 */
export const UNTESTABLE_STAGES: readonly string[] = ['publish', 'done'];

export const isTestableStage = (stage: string): boolean => !UNTESTABLE_STAGES.includes(stage);

/** Why the test control is off on those stages. */
export const UNTESTABLE_STAGE_HINT =
  'Publishing is the one stage that cannot be tested on its own - writing to the live site is all it does.';

/**
 * The statuses the agent's retry engine will re-queue an article from. A retry
 * against anything else is refused with a 409, so the panel holds the control
 * rather than offering a click whose only outcome is a banner.
 */
export const RETRYABLE_STATUSES: readonly string[] = [
  'failed',
  'timed_out',
  'cancelled',
  'waiting_approval',
];

/**
 * Whether a run's claim has run out. `null` is the agent's own answer for "no
 * lease is held" and reads as lapsed, exactly as its retry guard reads it;
 * `undefined` is an agent that does not report leases at all, where the panel
 * assumes the claim is live rather than offer a retry that would be refused.
 */
export const isLeaseLapsed = (
  leaseExpiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean => {
  if (leaseExpiresAt === undefined) return false;
  if (leaseExpiresAt === null) return true;
  const at = new Date(leaseExpiresAt).getTime();
  return Number.isFinite(at) ? at <= now : false;
};

/**
 * Whether this run can be retried at all. A running article is the one
 * conditional case: the agent refuses a retry under a live claim, and accepts
 * one whose claim has lapsed - which is exactly the stalled run this surface
 * exists to recover.
 */
export const isRetryableRun = (status: string, leaseLapsed = false): boolean =>
  RETRYABLE_STATUSES.includes(status) || (status === 'running' && leaseLapsed);

/** Why the retry control is off, in the terms the operator can act on. */
export const retryBlockedReason = (status: string): string => {
  if (status === 'running') {
    return 'Stop the run first - a stage that is still executing cannot be retried under itself.';
  }
  if (status === 'queued') return 'This run is queued and has not started yet - nothing to re-run.';
  return 'This run has finished. Run the whole pipeline again to rebuild it from research.';
};

/** Marker on a stage whose stored output a retry has superseded. */
export const OUT_OF_DATE_LABEL = 'Out of date';

/** Statuses whose work the triage row can still stop. Everything else is over. */
export const isStoppable = (status: string): boolean => status === 'running' || status === 'queued';

/**
 * The row-level stop on the triage surface. Work that has started is *stopped*;
 * work that is only queued is *cancelled* - the graceful/forceful split is the
 * mental model operators bring from comparable run dashboards, and a row that
 * says "cancel" over a stage mid-call reads as if nothing had begun.
 */
export const stopControlLabel = (status: string): string =>
  status === 'running' ? 'Stop run' : 'Cancel run';

/** What that control promises, so the destructive click is never a dead end. */
export const stopControlHint = (status: string): string =>
  status === 'running'
    ? 'Stop this run - you can re-run it from the run page'
    : 'Cancel this queued run - you can re-run it from the run page';

/**
 * What the surface says once the stop is accepted. A single row is stopped
 * without a confirmation dialog - the cheap-recovery path, not a habit-forming
 * prompt - so this line has to name the run that was hit, state what survived,
 * and sit next to the way back into it.
 *
 * `cancelling` is the agent's own answer: a running stage is asked to stop and
 * lets go later, a queued one is off the queue immediately.
 */
export const stoppedNotice = (title: string, cancelling: boolean): string =>
  cancelling
    ? `Stopping “${title}” - it stops where it is, and any partial output is kept as a draft.`
    : `“${title}” stopped - any partial output is kept as a draft.`;

/** One wedged run, as the Overview's triage surface lists it. */
export interface StuckRun {
  article_id: string;
  session_id?: string | null;
  title: string;
  stage?: string | null;
  /** Null only for a stage this panel knows no agent for. */
  agent: string | null;
  /** 'running' (past the soft bound, or its claim lapsed) or 'timed_out'. */
  status: string;
  started_at: string | null;
  /**
   * Null when the run's own clock is on no payload the panel holds: the reaper
   * clears the lease columns as it stops a run, so a stopped run's start
   * survives only on its session, and the session list is finite.
   */
  elapsed_seconds: number | null;
  budget_seconds: number;
  /** The claim's lease ran out - nothing is renewing it any more. */
  lease_expired?: boolean;
}

/** The article-list row this surface reads. */
export interface StuckArticle {
  id: string;
  title: string;
  stage: string;
  status: string;
  claimed_at?: string | null;
  lease_expires_at?: string | null;
  updated_at?: string | null;
}

/** The session-list row it reads alongside it. */
export interface StuckSession extends StageSession {
  id?: string;
  article_id?: string | null;
  ended_at?: string | null;
}

const millis = (iso?: string | null): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The session that ran this article's current state: same article, same
 * status, latest start. It carries the agent's name and, for a run that has
 * already stopped, the only surviving record of how long it ran. An isolated
 * test never describes the article's own state.
 */
function runSession(article: StuckArticle, sessions: StuckSession[]): StuckSession | null {
  let latest: StuckSession | null = null;
  let latestAt = -Infinity;
  for (const session of sessions) {
    if (session.article_id !== article.id || session.status !== article.status) continue;
    if (session.kind === 'test') continue;
    const startedAt = millis(session.started_at) ?? -Infinity;
    if (startedAt >= latestAt) {
      latest = session;
      latestAt = startedAt;
    }
  }
  return latest;
}

/**
 * How long this run has been on its stage. A live claim is measured the way
 * the agent's own reaper measures it - from the claim, else the article's last
 * write - so the panel and the thing that will stop the run agree on the
 * figure. A stopped run is measured off its session, because the claim it ran
 * under was cleared as it was stopped.
 */
function runElapsedSeconds(
  article: StuckArticle,
  session: StuckSession | null,
  now: number,
): number | null {
  if (article.status !== 'timed_out') {
    const start =
      millis(article.claimed_at) ?? millis(session?.started_at) ?? millis(article.updated_at);
    return start === null ? null : Math.max(0, (now - start) / 1000);
  }
  const start = millis(session?.started_at);
  if (start === null) return null;
  return Math.max(0, ((millis(session?.ended_at) ?? now) - start) / 1000);
}

/**
 * The runs the Overview puts above everything else: the ones the stage budget
 * already stopped, and the live ones that are past the soft bound of it or
 * whose claim has lapsed.
 *
 * Derived here rather than read off a field, because the agent's overview
 * reports no such section - what it serves is the article list, with the claim,
 * the lease and the budgets on it, which is exactly what the question is
 * decided from. Pure and clock-injectable, so the bands are tested rather than
 * eyeballed against a running pipeline.
 */
export function stuckRuns(
  articles: StuckArticle[],
  sessions: StuckSession[] = [],
  budgets?: StageBudgets | null,
  now: number = Date.now(),
): StuckRun[] {
  const runs: StuckRun[] = [];
  for (const article of articles) {
    if (article.status !== 'running' && article.status !== 'timed_out') continue;
    const budget = stageBudgetSeconds(article.stage, budgets);
    const session = runSession(article, sessions);
    const elapsed = runElapsedSeconds(article, session, now);
    const leaseExpired =
      article.status === 'running' && (millis(article.lease_expires_at) ?? Infinity) < now;
    // A live run inside the soft bound with its lease being renewed is simply
    // working, and listing it here would cost the surface its meaning.
    const inHand =
      article.status === 'running' &&
      !leaseExpired &&
      (elapsed === null || elapsedBand(elapsed, budget) === 'normal');
    if (inHand) continue;
    runs.push({
      article_id: article.id,
      session_id: session?.id ?? null,
      title: article.title,
      stage: article.stage,
      agent: session?.agent ?? STAGE_AGENT[article.stage] ?? null,
      status: article.status,
      started_at: session?.started_at ?? article.claimed_at ?? null,
      elapsed_seconds: elapsed,
      budget_seconds: budget,
      lease_expired: leaseExpired,
    });
  }
  return runs;
}

/**
 * The stages a retry left behind: the one it restarted from and everything
 * after it that the run has not been through again. The agent answers this
 * itself on the run detail, and this is the local derivation for an agent that
 * does not - it has to reach the same answer, because a marker that outlives
 * the content it describes is the one label this surface cannot afford to get
 * wrong.
 *
 * A stage clears once the run has moved past it, not only once a session for
 * it completed: the pipeline skips stages legitimately - `edit` runs only when
 * the review fails - and a skipped stage that stayed marked would leave a
 * live, published article carrying "Out of date" forever. A completed pipeline
 * session on the current attempt clears it too, for the moment between a stage
 * finishing and the run being moved on. A test run never clears anything - it
 * writes nothing.
 */
export function outOfDateStages(
  article: { stale_from_stage?: string | null; stage?: string | null; attempt?: number },
  sessions: StageSession[],
): Set<string> {
  const from = article.stale_from_stage;
  const start = from ? STAGE_ORDER.indexOf(from as Stage) : -1;
  if (start === -1) return new Set();
  /** Where the run stands now. -1 when the article does not report it. */
  const reached = article.stage ? STAGE_ORDER.indexOf(article.stage as Stage) : -1;
  const currentAttempt = article.attempt ?? 1;
  const regenerated = (stage: string): boolean =>
    sessions.some(
      (s) =>
        sessionStage(s) === stage &&
        s.kind !== 'test' &&
        s.status === 'done' &&
        (s.attempt ?? 1) >= currentAttempt,
    );
  return new Set(
    STAGE_ORDER.filter(
      (stage, i) => i >= start && i >= reached && stage !== 'done' && !regenerated(stage),
    ),
  );
}

/** The stages a retry from `stage` re-runs, in pipeline order. */
export const stagesRegeneratedBy = (stage: string): Stage[] => {
  const at = STAGE_ORDER.indexOf(stage as Stage);
  return at === -1 ? [] : STAGE_ORDER.slice(at).filter((s) => s !== 'done');
};

/** The stages a retry from `stage` keeps, reading their stored output. */
export const stagesKeptBy = (stage: string): Stage[] => {
  const at = STAGE_ORDER.indexOf(stage as Stage);
  return at <= 0 ? [] : STAGE_ORDER.slice(0, at);
};

/**
 * What POST /api/articles/:id/test-stage answers with. The call is synchronous
 * and can take minutes; nothing it produces is written to the article.
 */
export interface TestStageResult {
  stage: string;
  agent?: string;
  model?: string | null;
  summary?: string | null;
  output?: unknown;
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: string | number;
  session_id?: string;
  started_at?: string;
  ended_at?: string | null;
  /** Wall-clock of the isolated run, when the agent reports it directly. */
  duration_ms?: number;
}

/**
 * Read a test run out of whatever the agent answered with. The call is one
 * synchronous model call the operator has already paid for, so the result is
 * the one thing this panel must not drop on a shape it did not expect: the
 * body is taken either wrapped in `result` or on its own, and the figures are
 * read under either the column names or the camel-cased ones. An answer with
 * no stage at all is not a result and is reported as none.
 */
export function readTestStageResult(body: unknown): TestStageResult | null {
  if (!body || typeof body !== 'object') return null;
  const envelope = body as Record<string, unknown>;
  const raw = (
    envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope
  ) as Record<string, unknown>;
  if (typeof raw.stage !== 'string') return null;
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof raw[key] === 'string') return raw[key] as string;
    return undefined;
  };
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };
  return {
    stage: raw.stage,
    agent: str('agent'),
    model: str('model') ?? null,
    summary: str('summary') ?? null,
    output: raw.output,
    tokens_input: num('tokens_input', 'tokensInput'),
    tokens_output: num('tokens_output', 'tokensOutput'),
    cost_usd: num('cost_usd', 'costUsd'),
    session_id: str('session_id', 'sessionId'),
    started_at: str('started_at', 'startedAt'),
    ended_at: str('ended_at', 'endedAt') ?? null,
    duration_ms: num('duration_ms', 'durationMs'),
  };
}

/** One stage's attempts, newest attempt last, as the history renders them. */
export interface AttemptGroup<T extends StageSession = StageSession> {
  stage: string;
  sessions: T[];
}

/**
 * Attempt history for one article: its sessions grouped per stage in pipeline
 * order, ordered by attempt. A session this panel cannot place - a topic
 * search, or an agent it does not know - is never guessed into a group: it
 * stays in `ungrouped` and is listed flat.
 */
export function groupAttempts<T extends StageSession>(
  sessions: T[],
): { groups: Array<AttemptGroup<T>>; ungrouped: T[] } {
  const byStage = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const session of sessions) {
    const stage = sessionStage(session);
    if (!stage) {
      ungrouped.push(session);
      continue;
    }
    const bucket = byStage.get(stage) ?? [];
    bucket.push(session);
    byStage.set(stage, bucket);
  }
  const rank = (stage: string): number => {
    const at = STAGE_ORDER.indexOf(stage as Stage);
    return at === -1 ? STAGE_ORDER.length : at;
  };
  const groups = [...byStage.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([stage, rows]) => ({
      stage,
      sessions: [...rows].sort(
        (a, b) =>
          (a.attempt ?? 1) - (b.attempt ?? 1) ||
          new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      ),
    }));
  return { groups, ungrouped };
}
