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
// every article-writing stage (researcher, keyword strategist, outliner,
// writer, SEO reviewer, editor) follows the admin engine toggle, which
// defaults to Claude Opus 5. The topic scout and the image agent stay on
// Gemini. A per-agent model override may name any model from either engine.
import { config } from '../config.js';
import { getSetting } from '../db/pool.js';
import { geminiChat } from './gemini.js';
import { claudeChat, resolveClaudeCredential } from './claude.js';

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
 * ```json fence. Tries the whole string first, then the largest balanced
 * {...} or [...] block.
 */
export function extractJson<T>(text: string): T {
  const stripped = text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    /* fall through to block scan */
  }
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = text.indexOf(open);
    if (start === -1) continue;
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
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`Could not parse JSON from LLM response: ${text.slice(0, 200)}...`);
}

/** chat() + extractJson() with one automatic reprompt on parse failure. */
export async function chatJson<T>(opts: ChatOptions, tracker?: UsageTracker): Promise<T> {
  const first = await chat({ ...opts, jsonMode: true });
  tracker?.add(first);
  try {
    return extractJson<T>(first.text);
  } catch {
    const retry = await chat({
      ...opts,
      jsonMode: true,
      prompt: `${opts.prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON value — no prose, no code fences.`,
    });
    tracker?.add(retry);
    return extractJson<T>(retry.text);
  }
}
