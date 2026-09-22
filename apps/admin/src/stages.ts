/**
 * Stages, budgets and the elapsed-time threshold scale - the panel's share of
 * the contract it has with the agent: the fixed stage order, the two
 * boundaries that decide whether a run is slow or stuck, the fixed operator
 * copy, and the bookkeeping that turns a flat session list into per-stage
 * attempt history.
 *
 * Pure and dependency-free on purpose, so it is unit-tested in isolation the
 * way scrub.ts is (see stage-thresholds.test.ts). api.ts re-exports all of it.
 */

/** The slice of an agent session this module reasons about. */
export interface StageSession {
  /** Null on scout runs and on rows written before attempts were tracked. */
  stage?: string | null;
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

/** Marker on a stage whose stored output a retry has superseded. */
export const OUT_OF_DATE_LABEL = 'Out of date';

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
        s.stage === stage &&
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

/** One stage's attempts, newest attempt last, as the history renders them. */
export interface AttemptGroup<T extends StageSession = StageSession> {
  stage: string;
  sessions: T[];
}

/**
 * Attempt history for one article: its sessions grouped per stage in pipeline
 * order, ordered by attempt. A session with no stage is a scout run or a row
 * written before the retry engine - it is never guessed into a group, it stays
 * in `ungrouped` and is listed flat.
 */
export function groupAttempts<T extends StageSession>(
  sessions: T[],
): { groups: Array<AttemptGroup<T>>; ungrouped: T[] } {
  const byStage = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const session of sessions) {
    if (!session.stage) {
      ungrouped.push(session);
      continue;
    }
    const bucket = byStage.get(session.stage) ?? [];
    bucket.push(session);
    byStage.set(session.stage, bucket);
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
