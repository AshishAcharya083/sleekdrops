// What a stage is allowed to spend, in one place with no dependencies.
//
// The values here are read from three different processes - the runner that
// races a stage against its budget, the worker that reaps a claim nobody is
// renewing, and the admin API that shows an operator what the limit was - so
// this module deliberately imports nothing but configuration. Resolving a
// budget must not drag the agent graph (every prompt, every SDK client) into
// whichever process asked.
//
// None of it is operator-settable, and this is the one place that argument is
// written down. Comparable tooling treats an execution timeout as a
// config-time value under a fixed platform ceiling rather than a number on a
// settings page (Zapier's 30s is unchangeable, Make's 40min is a guardrail,
// GitHub Actions caps at 360min, n8n's author-facing field is bounded by an
// admin-set maximum), because a guard an operator can set to five seconds is a
// support surface - "someone set it to 5 seconds and everything fails" - not a
// safety feature. What the operator sees is the outcome: a 'timed_out' run
// whose message names the limit it hit. A stage that genuinely needs longer
// gets a per-stage override below, decided in code with its prompt.
import { config } from '../config.js';
import type { Stage } from './types.js';

/**
 * The hard ceiling, in code so no environment can raise it. Two hours is
 * already far past any healthy stage - the longest legitimate run measured
 * here is an seo_review at roughly 90 minutes - so a budget above this is a
 * misconfiguration, not a long job.
 */
export const MAX_STAGE_TIMEOUT_SECONDS = 7200;

/**
 * How often a running stage renews its lease. Well inside STAGE_LEASE_SECONDS
 * so a handful of missed renewals - a GC pause, a slow database - does not
 * cost a live run its claim, and short enough that a cancelled or reaped run
 * notices it has lost the article within half a minute.
 */
export const STAGE_HEARTBEAT_SECONDS = 30;

/**
 * Per-stage wall-clock budget, in seconds, for the stages that genuinely
 * differ from AGENT_RUN_TIMEOUT_SECONDS. Part of the stage definition - it is
 * re-exported next to STAGE_AGENT in runner.ts, which is where a stage is
 * defined - and deliberately not a database row or a Settings field: it is a
 * property of the stage, decided with its prompt and its model, not a knob an
 * operator tunes per run. Every value here is still capped by
 * MAX_STAGE_TIMEOUT_SECONDS.
 *
 * Empty means every stage runs on the configured budget, which is the state
 * today: the longest legitimate run measured is an seo_review at roughly 90
 * minutes, and that is a stage to make faster, not one to give more time.
 */
export const STAGE_TIMEOUT_SECONDS: Partial<Record<Exclude<Stage, 'done'>, number>> = {};

/**
 * The budget for one stage: its own override if it has one, otherwise
 * AGENT_RUN_TIMEOUT_SECONDS, never above the ceiling. A nonsensical override
 * (zero, negative, NaN) falls back to the configured value the same way the
 * configured value falls back to its default.
 */
export function stageBudgetSeconds(stage: Stage): number {
  const override = stage === 'done' ? undefined : STAGE_TIMEOUT_SECONDS[stage];
  const wanted =
    override !== undefined && Number.isFinite(override) && override > 0
      ? override
      : config.agentRunTimeoutSeconds;
  return Math.min(wanted, MAX_STAGE_TIMEOUT_SECONDS);
}
