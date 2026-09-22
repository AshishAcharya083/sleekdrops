// The budget a stage runs under, and the error an operator reads when it runs
// out.
//
// Two things happen here and both are deliberate. The budget is resolved
// against a ceiling that lives in code, so no environment can hand a stage an
// unbounded run - configuration says what it wants, this says what it gets.
// And every message is built through the scrubber below, because the strings
// that land in agent_sessions.error are the ones an SDK wrote about the child
// process it just ran, and that child's environment is where the Claude
// subscription token lives.
import { config, MAX_STAGE_TIMEOUT_SECONDS } from '../config.js';
import { formatDuration } from '../llm/callTrace.js';
import { StageTimeoutError, type StageTimeoutDetail } from './types.js';

/**
 * The budget for one stage: the per-stage override if the stage definition map
 * carries one, otherwise AGENT_RUN_TIMEOUT_SECONDS, never above the ceiling.
 * A nonsensical override (zero, negative, NaN) falls back to the configured
 * value the same way the configured value falls back to the default.
 */
export function stageBudgetSeconds(override?: number): number {
  const wanted =
    override !== undefined && Number.isFinite(override) && override > 0
      ? override
      : config.agentRunTimeoutSeconds;
  return Math.min(wanted, MAX_STAGE_TIMEOUT_SECONDS);
}

/** A limit as an operator states it: "60 minutes", "90 seconds". */
export function formatBudget(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return seconds >= 60 && seconds % 60 === 0
    ? plural(seconds / 60, 'minute')
    : plural(Math.round(seconds), 'second');
}

/**
 * Environment variables whose VALUE is a credential. Matched on the name
 * because the set is open-ended - every deployment adds its own - and a name
 * is the only thing that reliably says "this string is a secret".
 */
const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|CONNECTION_STRING/;

/**
 * Short values are not redacted: PGPASSWORD=app would otherwise blank every
 * "app" in the sentence, and a three-character password is not what leaks.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes redacted wherever they appear, whether or not this process
 * holds the value. The admin panel can store a Claude subscription token that
 * never reaches our own environment - it is injected straight into the child's
 * - so the token's own shape has to be a rule as well.
 */
const SECRET_SHAPES: Array<{ pattern: RegExp; as: string }> = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, as: '[redacted Anthropic credential]' },
  { pattern: /AIza[A-Za-z0-9_-]{20,}/g, as: '[redacted Google API key]' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, as: '[redacted GitHub token]' },
  { pattern: /\btvly-[A-Za-z0-9_-]{8,}/g, as: '[redacted Tavily key]' },
  { pattern: /(Bearer|Authorization:)\s+[A-Za-z0-9._~+/-]{16,}=*/g, as: '$1 [redacted]' },
];

/**
 * Remove credential values from text that is about to be persisted or logged.
 *
 * `env` is the environment to treat as the source of secrets - by default this
 * process's, which is what the Claude Agent SDK's child inherits.
 */
export function scrubSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let scrubbed = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_ENV_NAME.test(name)) continue;
    // split/join, not a regex: a credential can contain regex metacharacters.
    if (scrubbed.includes(value)) scrubbed = scrubbed.split(value).join(`[redacted ${name}]`);
  }
  for (const { pattern, as } of SECRET_SHAPES) scrubbed = scrubbed.replace(pattern, as);
  return scrubbed;
}

/**
 * What stopped, and why, in the words the run detail shows. Names the agent,
 * the stage, the limit, how long it actually ran and the last LLM call it
 * started - the five things that decide what an operator does next - and goes
 * through the scrubber on the way out.
 */
export function stageTimeoutMessage(
  detail: StageTimeoutDetail,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const limit = formatBudget(detail.budgetSeconds);
  const elapsed = formatDuration(detail.elapsedSeconds);
  const nothingNoted =
    detail.cause === 'lease'
      ? 'The worker holding it did not report what it was waiting on.'
      : 'No LLM call had started, so the stage stopped somewhere other than a model call.';
  const lastCall = detail.lastCall
    ? `Last LLM call attempted: ${detail.lastCall}.`
    : nothingNoted;
  const what =
    detail.cause === 'budget'
      ? `Stopped after ${limit} (the limit for the ${detail.agent} agent) at the ${detail.stage} stage, having run for ${elapsed}.`
      : `Stopped at the ${detail.stage} stage: the ${detail.agent} agent stopped reporting progress and its claim was reaped after ${elapsed} (the limit for this agent is ${limit}).`;
  return scrubSecrets(
    `${what} ${lastCall} Any partial output has been saved as a draft.`,
    env,
  );
}

/** The error a stopped stage is routed on. The only place one is built. */
export function stageTimeoutError(
  detail: StageTimeoutDetail,
  env: NodeJS.ProcessEnv = process.env,
): StageTimeoutError {
  return new StageTimeoutError(stageTimeoutMessage(detail, env), detail);
}
