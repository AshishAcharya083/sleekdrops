// Gemini engine — single-shot generation through Google ADK. Each call builds
// a throwaway LlmAgent and runs it on an ephemeral in-memory session; the
// pipeline's own state lives in Postgres, so nothing here persists.
import { Gemini, InMemoryRunner, LlmAgent, isFinalResponse, stringifyContent } from '@google/adk';
import { config } from '../config.js';
import type { ChatOptions, LlmResult, LlmSettings } from './index.js';

function geminiModel(model: string, settings: LlmSettings): Gemini {
  const normalized = model.replace(/^google\//, '');
  // Admin-set key wins; then Vertex ADC (the Cloud Run setup — keyless);
  // then GEMINI_API_KEY from .env for local dev.
  const apiKey = settings.gemini_api_key || undefined;
  if (apiKey) return new Gemini({ model: normalized, apiKey });
  if (config.vertex.enabled) {
    return new Gemini({
      model: normalized,
      vertexai: true,
      project: config.vertex.project,
      location: config.vertex.location,
    });
  }
  if (config.geminiApiKey) return new Gemini({ model: normalized, apiKey: config.geminiApiKey });
  throw new Error(
    'Gemini engine not configured — paste an AI Studio key in admin Settings, set ' +
      'GEMINI_API_KEY in apps/agent/.env, or run with GOOGLE_GENAI_USE_VERTEXAI=true on GCP',
  );
}

export async function geminiChat(opts: ChatOptions, settings: LlmSettings): Promise<LlmResult> {
  const agent = new LlmAgent({
    name: 'sleekdrops_stage',
    model: geminiModel(opts.model, settings),
    instruction: opts.system ?? '',
    generateContentConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 8192,
      ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  });
  const runner = new InMemoryRunner({ agent, appName: 'sleekdrops' });

  let text = '';
  let tokensInput = 0;
  let tokensOutput = 0;
  for await (const event of runner.runEphemeral({
    userId: 'pipeline',
    newMessage: { role: 'user', parts: [{ text: opts.prompt }] },
  })) {
    if (event.usageMetadata) {
      tokensInput = event.usageMetadata.promptTokenCount ?? tokensInput;
      tokensOutput = event.usageMetadata.candidatesTokenCount ?? tokensOutput;
    }
    if (isFinalResponse(event)) text = stringifyContent(event);
  }
  if (!text) throw new Error('Gemini engine returned an empty completion');
  return {
    text,
    model: opts.model.replace(/^google\//, ''),
    // Gemini bills the GCP project (AI Studio key or Vertex) — no per-call USD
    // figure comes back, so cost stays 0 and tokens carry the signal.
    usage: { tokensInput, tokensOutput, costUsd: 0 },
  };
}
