// Direct @google/genai client for the multimodal work the ADK text wrapper
// doesn't cover: vision checks on candidate hero images. Credential resolution
// mirrors llm/gemini.ts — admin-set AI Studio key, else Vertex ADC (Cloud Run),
// else GEMINI_API_KEY from .env.
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { extractJson, llmSettings } from './index.js';

let cached: GoogleGenAI | null = null;

async function client(): Promise<GoogleGenAI> {
  if (cached) return cached;
  const settings = await llmSettings();
  const apiKey = settings.gemini_api_key || config.geminiApiKey || undefined;
  if (apiKey) {
    cached = new GoogleGenAI({ apiKey });
  } else if (config.vertex.enabled) {
    cached = new GoogleGenAI({
      vertexai: true,
      project: config.vertex.project,
      location: config.vertex.location,
    });
  } else {
    throw new Error(
      'Gemini not configured — paste an AI Studio key in admin Settings, set ' +
        'GEMINI_API_KEY in apps/agent/.env, or run with GOOGLE_GENAI_USE_VERTEXAI=true on GCP',
    );
  }
  return cached;
}

/** Reset the cached client (e.g. after the admin swaps the API key). */
export function resetGenaiClient(): void {
  cached = null;
}

/**
 * Ask a vision-capable Gemini model a question about one image and parse the
 * JSON reply. `mimeType` must be a real image mime (image/jpeg, image/png, …).
 */
export async function visionJson<T>(
  model: string,
  image: { data: Buffer; mimeType: string },
  prompt: string,
): Promise<T> {
  const ai = await client();
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } },
          { text: prompt },
        ],
      },
    ],
    config: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  const text = res.text ?? '';
  if (!text) throw new Error('vision model returned an empty response');
  return extractJson<T>(text);
}
