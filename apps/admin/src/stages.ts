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

/**
 * The stages a retry left behind: the one it restarted from and everything
 * after it, until a pipeline session for that stage completes on the current
 * attempt. A test run never clears the marker - it writes nothing.
 */
export function outOfDateStages(
  article: { stale_from_stage?: string | null; attempt?: number },
  sessions: StageSession[],
): Set<string> {
  const from = article.stale_from_stage;
  const start = from ? STAGE_ORDER.indexOf(from as Stage) : -1;
  if (start === -1) return new Set();
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
    STAGE_ORDER.slice(start).filter((stage) => stage !== 'done' && !regenerated(stage)),
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
