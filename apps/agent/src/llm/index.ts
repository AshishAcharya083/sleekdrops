// LLM abstraction layer — two engines, routed by model id at call time:
//
//   gemini  — every model id that isn't claude-*. Runs through Google's Agent
//             Development Kit (@google/adk). Auth: admin-set API key, else
//             Vertex AI ADC (GOOGLE_GENAI_USE_VERTEXAI=true on Cloud Run),
//             else GEMINI_API_KEY from .env.
//   claude  — model ids starting with "claude". Runs through the Claude Agent
//             SDK (@anthropic-ai/claude-agent-sdk), which authenticates with a
//             Claude subscription via CLAUDE_CODE_OAUTH_TOKEN (from `claude
//             setup-token`) — or ANTHROPIC_API_KEY as a pay-per-token fallback.
//             The token only works through the Agent SDK/CLI; it is NOT an API
//             bearer, which is why this engine exists at all.
//
// Which agents use which engine is decided in pipeline/runner.ts (modelFor):
// every stage that runs a prompt — topic scout, researcher, keyword
// strategist, outliner, writer, SEO reviewer, editor — follows the admin
// engine toggle, which defaults to Claude Opus 5. The image agent is the one
// exception and is pinned to Gemini, because vision checking and image
// generation are that engine's capabilities, not a preference. A per-agent
// model override may name any model from either engine.
//
// Both engines can be given live web search (`search: true`) so a stage can
// check a fact instead of trusting its context: Gemini uses Google Search
// grounding, Claude uses the in-process tools in ./searchTools.ts.
import { config } from '../config.js';
import { getSetting } from '../db/pool.js';
import { geminiChat } from './gemini.js';
import { claudeChat, CLAUDE_NOT_CONFIGURED, resolveClaudeCredential } from './claude.js';

export { CLAUDE_NOT_CONFIGURED };

export interface LlmSettings {
  /** Google AI Studio key. Empty = Vertex ADC (Cloud Run) or GEMINI_API_KEY. */
  gemini_api_key?: string;
  /** Default Gemini model for every agent without an override. */
  gemini_model?: string;
  /** Claude subscription OAuth token from `claude setup-token`. */
  claude_token?: string;
  /** Model the Claude engine runs. Defaults to claude-opus-5. */
  claude_model?: string;
  /**
   * Engine for every article-writing stage: Claude subscription or Gemini.
   * Named `prose_engine` for the settings rows already in the database — it
   * covered writer + editor only when it was introduced, and now covers
   * research, keyword strategy, outlining and review as well.
   */
  prose_engine?: 'claude' | 'gemini';
}

let llmCache: { value: LlmSettings; at: number } | null = null;

/** Admin-settable LLM config, cached for 30s to spare the DB. */
export async function llmSettings(): Promise<LlmSettings> {
  if (llmCache && Date.now() - llmCache.at < 30_000) return llmCache.value;
  const value = await getSetting<LlmSettings>('llm', {});
  llmCache = { value, at: Date.now() };
  return value;
}

/**
 * Drop the cache after an admin save. Without this, pasting a Claude token
 * leaves the engine reporting itself unconfigured — and the pipeline refusing
 * to start on it — for up to another 30 seconds.
 */
export function clearLlmSettingsCache(): void {
  llmCache = null;
}

export function defaultGeminiModel(s: LlmSettings): string {
  // Tolerate the old OpenRouter-style "google/gemini-*" ids in stale settings.
  return (s.gemini_model || config.geminiModelDefault).replace(/^google\//, '');
}

export function defaultClaudeModel(s: LlmSettings): string {
  return (s.claude_model || config.claude.modelDefault).replace(/^anthropic\//, '');
}

export const isClaudeModel = (model: string): boolean =>
  model.replace(/^anthropic\//, '').startsWith('claude');

/** True when the Claude engine has a usable credential (token or API key). */
export async function claudeConfigured(): Promise<boolean> {
  return (await resolveClaudeCredential(await llmSettings())) !== null;
}

/** Where an engine's credential came from — reported, never the value itself. */
export type CredentialSource =
  | 'admin-settings'
  | 'env-oauth-token'
  | 'env-api-key'
  | 'vertex-adc'
  | null;

export interface EngineReadiness {
  configured: boolean;
  source: CredentialSource;
}

export interface EngineStatus {
  claude: EngineReadiness;
  gemini: EngineReadiness;
}

/**
 * Which engines can actually run, for the admin panel.
 *
 * This exists because the failure it reports used to be invisible: the toggle
 * said Claude, no token was set anywhere, and every stage quietly ran on
 * Gemini and wrote `gemini-2.5-flash` into its session row. The panel now says
 * so before a single article is queued.
 */
export async function engineStatus(): Promise<EngineStatus> {
  const settings = await llmSettings();
  const credential = resolveClaudeCredential(settings);
  return {
    claude: {
      configured: credential !== null,
      source:
        credential === null
          ? null
          : settings.claude_token
            ? 'admin-settings'
            : credential.envName === 'CLAUDE_CODE_OAUTH_TOKEN'
              ? 'env-oauth-token'
              : 'env-api-key',
    },
    gemini: settings.gemini_api_key
      ? { configured: true, source: 'admin-settings' }
      : config.vertex.enabled
        ? { configured: true, source: 'vertex-adc' }
        : config.geminiApiKey
          ? { configured: true, source: 'env-api-key' }
          : { configured: false, source: null },
  };
}

export interface LlmUsage {
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface ChatOptions {
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the engine for a JSON object response (best effort). */
  jsonMode?: boolean;
  /**
   * Give the model live web search so it can verify what it is about to say.
   * Only the stages that check facts turn this on — the writer and the editor
   * work from the dossier alone, so a draft can never quietly acquire a source
   * nobody reviewed.
   */
  search?: boolean;
}

/** Accumulates usage across the several LLM calls one agent run makes. */
export class UsageTracker {
  tokensInput = 0;
  tokensOutput = 0;
  costUsd = 0;
  llmCalls = 0;
  models = new Set<string>();

  add(result: LlmResult): void {
    this.tokensInput += result.usage.tokensInput;
    this.tokensOutput += result.usage.tokensOutput;
    this.costUsd += result.usage.costUsd;
    this.llmCalls += 1;
    this.models.add(result.model);
  }
}

export async function chat(opts: ChatOptions): Promise<LlmResult> {
  const settings = await llmSettings();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      return isClaudeModel(opts.model)
        ? await claudeChat(opts, settings)
        : await geminiChat(opts, settings);
    } catch (err) {
      lastError = err;
      // Config errors won't fix themselves — only retry transient failures.
      if (err instanceof Error && /not configured|no credential/i.test(err.message)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Extract a JSON value from an LLM response that may wrap it in prose or a
 * ```json fence.
 *
 * The balanced scan starts at whichever structural character comes FIRST and
 * only ever returns a COMPLETE outer value. That is deliberate and it is the
 * whole point of this function: the earlier version tried `{` and then fell
 * back to `[`, so a reply cut off mid-object would skip past the unterminated
 * `{` and return the first complete array nested inside it. A truncated
 * research dossier came back as its own `facts` array — valid JSON, plausible
 * shape, silently missing every product — and the pipeline published from it.
 * A truncated value must fail here so chatJson can reprompt.
 */
export function extractJson<T>(text: string): T {
  const stripped = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    /* fall through to the balanced scan */
  }

  const objectAt = text.indexOf('{');
  const arrayAt = text.indexOf('[');
  const candidates = [objectAt, arrayAt].filter((i) => i !== -1);
  if (candidates.length === 0) {
    throw new Error(`No JSON value in LLM response: ${text.slice(0, 200)}...`);
  }
  const start = Math.min(...candidates);
  const open = text[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
    }
  }
  // Unbalanced: the value was cut off. Never reach inside it for a fragment.
  throw new Error(
    `Truncated JSON in LLM response — the outer ${open}...${close} never closes: ${text.slice(0, 200)}...`,
  );
}

/**
 * A shape check for a JSON stage. Returns null when the value is usable, or a
 * complaint that is fed back to the model verbatim on the reprompt.
 *
 * Valid JSON of the wrong shape is the failure mode worth guarding: it flows
 * through `?? []` and `?.field` defaults all the way to a published article
 * with nothing in it, and every stage in between reports success.
 */
export type ShapeCheck<T> = (value: unknown) => string | null;

/** The common case: a JSON object (not an array) carrying these keys. */
export function requireKeys<T>(...keys: Array<keyof T & string>): ShapeCheck<T> {
  return (value) => {
    if (value === null || typeof value !== 'object') return `Expected a JSON object, got ${value === null ? 'null' : typeof value}.`;
    if (Array.isArray(value)) {
      return 'Expected a JSON object, got an array — return the whole object, not one of its fields.';
    }
    const missing = keys.filter((k) => (value as Record<string, unknown>)[k] === undefined);
    return missing.length > 0 ? `Missing required field(s): ${missing.join(', ')}.` : null;
  };
}

/**
 * chat() + extractJson() with one automatic reprompt, on a parse failure OR a
 * shape failure. `check` is what stops a well-formed reply of the wrong shape
 * reaching the database — pass one for any stage whose output is load-bearing.
 */
export async function chatJson<T>(
  opts: ChatOptions,
  tracker?: UsageTracker,
  check?: ShapeCheck<T>,
): Promise<T> {
  const attempt = async (complaint?: string): Promise<T> => {
    const result = await chat({
      ...opts,
      jsonMode: true,
      prompt: complaint ? `${opts.prompt}\n\n${complaint}` : opts.prompt,
    });
    tracker?.add(result);
    const value = extractJson<T>(result.text);
    const problem = check?.(value);
    if (problem) throw new Error(problem);
    return value;
  };

  try {
    return await attempt();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return attempt(
      `Your previous reply could not be used: ${why}\nReply with ONLY the complete JSON value — no prose, no code fences, and do not omit any field.`,
    );
  }
}
