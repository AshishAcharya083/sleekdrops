// Claude engine — generation through the Claude Agent SDK, which is the only
// sanctioned consumer of a Claude subscription OAuth token
// (CLAUDE_CODE_OAUTH_TOKEN, minted by `claude setup-token`). Same pattern as
// devteam-platform: the credential is resolved per run, injected into the
// child process environment only (never an argv), and a token outranks an
// ANTHROPIC_API_KEY so the subscription actually gets used.
//
// The engine runs in one of two shapes:
//   single-shot  — one turn, no tools. The default: the stage was handed its
//                  evidence and answers from it.
//   verifying    — `search: true`. The model gets live web search and a page
//                  reader (llm/searchTools.ts) and several turns to use them
//                  before it answers. Only the stages that check facts ask for
//                  this; the writer and editor never do.
//
// Isolation is deliberate in both shapes: no built-in tools, no filesystem
// settings, no MCP config beyond the one server we pass, and a cwd outside any
// repo — so a CLAUDE.md or a ~/.claude/settings.json on the host can never
// change what a published article says.
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { VERIFY_TOOLS, verificationServer } from './searchTools.js';
import type { ChatOptions, LlmResult, LlmSettings } from './index.js';

/**
 * Turn budget when search is on. Generous enough for a handful of searches and
 * the pages behind them, bounded so a model that keeps looking can't run the
 * stage into the worker's 30-minute stranded-claim recovery.
 */
const SEARCH_MAX_TURNS = 24;

/**
 * Turn budget without tools. Not 1, which is what this was and what broke the
 * outline stage the first time a real token was configured: a turn is one
 * assistant response, Opus 5 runs adaptive thinking by default, and a reply
 * that arrives as thinking-then-answer spends two. At 1 that failed outright
 * with `error_max_turns`, intermittently — the same call succeeded on a retry,
 * which is the worst kind of bug to read off a dashboard.
 *
 * Headroom is close to free here: with `tools: []` there is nothing to call,
 * so the only thing extra turns buy is the model finishing its sentence.
 */
const SINGLE_SHOT_MAX_TURNS = 6;

const TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeCredential {
  envName: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  value: string;
}

/** Admin-set token → .env token → API key fallback → null (engine disabled). */
export function resolveClaudeCredential(settings: LlmSettings): ClaudeCredential | null {
  const token = settings.claude_token || config.claude.oauthToken;
  if (token) return { envName: 'CLAUDE_CODE_OAUTH_TOKEN', value: token };
  if (config.claude.apiKey) return { envName: 'ANTHROPIC_API_KEY', value: config.claude.apiKey };
  return null;
}

export const CLAUDE_NOT_CONFIGURED =
  'Claude engine not configured — paste a subscription token (from `claude setup-token`) ' +
  'in admin Settings, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in apps/agent/.env';

/**
 * The SDK options for one run. Split out so the isolation guarantees can be
 * asserted without a credential or a network: no built-in tools in either
 * shape, no host settings, no MCP config beyond ours, and search tools only
 * when the caller actually asked to verify something.
 */
export function queryOptions(
  opts: Pick<ChatOptions, 'system' | 'search'>,
  model: string,
  env: Record<string, string>,
) {
  return {
    systemPrompt: opts.system ?? '',
    model,
    maxTurns: opts.search ? SEARCH_MAX_TURNS : SINGLE_SHOT_MAX_TURNS,
    // No built-in tools in either shape: no Bash, no file access, no network
    // beyond the search server below.
    tools: [],
    ...(opts.search
      ? { mcpServers: { verify: verificationServer() }, allowedTools: VERIFY_TOOLS }
      : { allowedTools: [] }),
    strictMcpConfig: true,
    settingSources: [], // ignore ~/.claude and any project settings
    env,
    cwd: tmpdir(), // keep the CLI away from any repo's CLAUDE.md/settings
  };
}

export async function claudeChat(opts: ChatOptions, settings: LlmSettings): Promise<LlmResult> {
  const credential = resolveClaudeCredential(settings);
  if (!credential) throw new Error(CLAUDE_NOT_CONFIGURED);

  // Exactly one Anthropic credential in the child env: an inherited API key
  // would silently outrank the subscription token in the CLI's precedence.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'CLAUDE_CODE_OAUTH_TOKEN') env[k] = v;
  }
  env[credential.envName] = credential.value;

  // Note: opts.maxTokens has no effect here. The Agent SDK exposes no output
  // budget, so the model's own default cap (64K on Opus 5) applies. It is a
  // Gemini-engine hint only — don't rely on it to bound a Claude reply.
  const model = opts.model.replace(/^anthropic\//, '');
  const prompt = opts.jsonMode
    ? `${opts.prompt}\n\nReply with ONLY the JSON value — no prose, no code fences.`
    : opts.prompt;

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const run = query({
      prompt,
      options: { ...queryOptions(opts, model, env), abortController: abort },
    });
    for await (const message of run) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        const budget = opts.search ? SEARCH_MAX_TURNS : SINGLE_SHOT_MAX_TURNS;
        throw new Error(
          message.subtype === 'error_max_turns'
            ? `Claude engine hit its ${budget}-turn budget before answering`
            : `Claude engine failed (${message.subtype})`,
        );
      }
      if (!message.result) throw new Error('Claude engine returned an empty completion');
      const usage = message.usage;
      return {
        text: message.result,
        model,
        usage: {
          tokensInput:
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
          tokensOutput: usage.output_tokens ?? 0,
          // 0 on a subscription; real USD when the API-key fallback is active.
          costUsd: message.total_cost_usd ?? 0,
        },
      };
    }
    throw new Error('Claude engine ended without a result message');
  } finally {
    clearTimeout(timeout);
  }
}
