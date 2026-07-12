// Claude engine — single-shot generation through the Claude Agent SDK, which
// is the only sanctioned consumer of a Claude subscription OAuth token
// (CLAUDE_CODE_OAUTH_TOKEN, minted by `claude setup-token`). Same pattern as
// devteam-platform: the credential is resolved per run, injected into the
// child process environment only (never an argv), and a token outranks an
// ANTHROPIC_API_KEY so the subscription actually gets used.
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { ChatOptions, LlmResult, LlmSettings } from './index.js';

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

export async function claudeChat(opts: ChatOptions, settings: LlmSettings): Promise<LlmResult> {
  const credential = resolveClaudeCredential(settings);
  if (!credential) {
    throw new Error(
      'Claude engine not configured — paste a subscription token (from `claude setup-token`) ' +
        'in admin Settings, or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in apps/agent/.env',
    );
  }

  // Exactly one Anthropic credential in the child env: an inherited API key
  // would silently outrank the subscription token in the CLI's precedence.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'CLAUDE_CODE_OAUTH_TOKEN') env[k] = v;
  }
  env[credential.envName] = credential.value;

  const model = opts.model.replace(/^anthropic\//, '');
  const prompt = opts.jsonMode
    ? `${opts.prompt}\n\nReply with ONLY the JSON value — no prose, no code fences.`
    : opts.prompt;

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000);
  try {
    const run = query({
      prompt,
      options: {
        systemPrompt: opts.system ?? '',
        model,
        maxTurns: 1,
        allowedTools: [],
        env,
        cwd: tmpdir(), // keep the CLI away from any repo's CLAUDE.md/settings
        abortController: abort,
      },
    });
    for await (const message of run) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        throw new Error(`Claude engine failed (${message.subtype})`);
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
