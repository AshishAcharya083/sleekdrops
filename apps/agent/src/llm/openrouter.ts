// LLM abstraction layer. Every agent talks to an OpenAI-compatible chat API;
// which one is decided at call time from admin settings ('llm' key), with
// .env as fallback. Built-in providers:
//   openrouter — one key, any model (google/*, anthropic/*, openai/*, ...)
//   gemini     — Google AI Studio's OpenAI-compatible endpoint; bills the
//                key's GCP project, so Google Cloud credits apply
//   custom     — any other OpenAI-compatible endpoint (vLLM, LiteLLM, ...)
import { config } from '../config.js';
import { getSetting } from '../db/pool.js';

export interface LlmProviderSettings {
  provider?: 'openrouter' | 'gemini' | 'custom';
  base_url?: string;
  api_key?: string;
  default_model?: string;
}

interface ProviderPreset {
  baseUrl: string;
  envApiKey: () => string;
  defaultModel: () => string;
  /** Map cross-provider model ids to what this provider expects. */
  normalizeModel: (model: string) => string;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envApiKey: () => config.openrouter.apiKey,
    defaultModel: () => config.modelDefault,
    normalizeModel: (m) => m,
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envApiKey: () => config.geminiApiKey,
    // OpenRouter-style "google/gemini-2.5-flash" → "gemini-2.5-flash".
    defaultModel: () => config.modelDefault.replace(/^google\//, ''),
    normalizeModel: (m) => m.replace(/^google\//, ''),
  },
  custom: {
    baseUrl: config.openrouter.baseUrl,
    envApiKey: () => config.openrouter.apiKey,
    defaultModel: () => config.modelDefault,
    normalizeModel: (m) => m,
  },
};

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  normalizeModel: (model: string) => string;
}

let llmCache: { value: LlmProviderSettings; at: number } | null = null;

/** Admin-settable provider config, cached for 30s to spare the DB. */
export async function llmSettings(): Promise<LlmProviderSettings> {
  if (llmCache && Date.now() - llmCache.at < 30_000) return llmCache.value;
  const value = await getSetting<LlmProviderSettings>('llm', {});
  llmCache = { value, at: Date.now() };
  return value;
}

/** Settings win field-by-field; the preset fills the gaps. */
export async function resolveProvider(): Promise<ResolvedProvider> {
  const s = await llmSettings();
  const name = s.provider && PROVIDERS[s.provider] ? s.provider : 'openrouter';
  const preset = PROVIDERS[name];
  return {
    name,
    baseUrl: (s.base_url || preset.baseUrl).replace(/\/+$/, ''),
    apiKey: s.api_key || preset.envApiKey(),
    defaultModel: s.default_model || preset.defaultModel(),
    normalizeModel: preset.normalizeModel,
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
  /** Ask the provider for a JSON object response (best effort). */
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

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function chat(opts: ChatOptions): Promise<LlmResult> {
  const provider = await resolveProvider();
  if (!provider.apiKey) {
    throw new Error(
      `No LLM API key configured for provider "${provider.name}" — set it in admin Settings, ` +
        'or OPENROUTER_API_KEY / GEMINI_API_KEY in apps/agent/.env',
    );
  }
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });

  const body: Record<string, unknown> = {
    model: provider.normalizeModel(opts.model),
    messages,
    temperature: opts.temperature ?? 0.7,
  };
  // OpenRouter-only extension: include the billed USD cost in the usage block.
  if (provider.name === 'openrouter') body.usage = { include: true };
  // Always cap output: uncapped requests make OpenRouter reserve the model's
  // full completion window up front, which 402s on small credit balances.
  body.max_tokens = opts.maxTokens ?? 8192;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.openrouter.siteUrl,
          'X-Title': config.openrouter.appName,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        lastError = new Error(`LLM provider HTTP ${res.status}: ${text.slice(0, 500)}`);
        if (RETRYABLE.has(res.status)) continue;
        throw lastError;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        model?: string;
        error?: { message?: string };
      };
      if (json.error) throw new Error(`LLM provider error: ${json.error.message}`);
      const text = json.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('LLM provider returned an empty completion');
      return {
        text,
        model: json.model ?? provider.normalizeModel(opts.model),
        usage: {
          tokensInput: json.usage?.prompt_tokens ?? 0,
          tokensOutput: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? 0,
        },
      };
    } catch (err) {
      lastError = err;
      // Network errors are retryable; anything thrown above already decided.
      if (err instanceof Error && err.message.startsWith('LLM provider')) throw err;
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
