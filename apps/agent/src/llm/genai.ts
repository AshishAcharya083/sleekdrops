// Direct @google/genai client for the multimodal work the ADK text wrapper
// doesn't cover: vision checks on candidate hero images and image generation.
// Credential resolution mirrors llm/gemini.ts — admin-set AI Studio key, else
// Vertex ADC (Cloud Run), else GEMINI_API_KEY from .env.
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { extractJson, llmSettings } from './index.js';
import { activeModelStub } from './modelStub.js';

const cached = new Map<string, GoogleGenAI>();

/** The client for one platform's credential - each platform may set its own key. */
async function client(platformId: string): Promise<GoogleGenAI> {
  const existing = cached.get(platformId);
  if (existing) return existing;
  const settings = await llmSettings(platformId);
  const apiKey = settings.gemini_api_key || config.geminiApiKey || undefined;
  let created: GoogleGenAI;
  if (apiKey) {
    created = new GoogleGenAI({ apiKey });
  } else if (config.vertex.enabled) {
    created = new GoogleGenAI({
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
  cached.set(platformId, created);
  return created;
}

/** Reset every platform's cached client (e.g. after the admin swaps the API key). */
export function resetGenaiClient(): void {
  cached.clear();
}

/**
 * Ask a vision-capable Gemini model a question about one image and parse the
 * JSON reply. `mimeType` must be a real image mime (image/jpeg, image/png, …).
 */
export async function visionJson<T>(
  platformId: string,
  model: string,
  image: { data: Buffer; mimeType: string },
  prompt: string,
): Promise<T> {
  const stub = activeModelStub();
  if (stub) return extractJson<T>(await stub({ kind: 'vision', model, prompt }));
  const ai = await client(platformId);
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

/**
 * Generate one image and return its bytes. Uses the Gemini image model
 * (gemini-2.5-flash-image); retries once without imageConfig for older
 * API surfaces that reject it.
 */
export async function generateImage(
  platformId: string,
  prompt: string,
  model = 'gemini-2.5-flash-image',
): Promise<{ data: Buffer; mimeType: string }> {
  const stub = activeModelStub();
  if (stub) {
    return { data: Buffer.from(await stub({ kind: 'image', model, prompt }), 'base64'), mimeType: 'image/png' };
  }
  const ai = await client(platformId);
  const attempt = async (withAspect: boolean) =>
    ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        ...(withAspect ? { imageConfig: { aspectRatio: '16:9' } } : {}),
      },
    });

  let res;
  try {
    res = await attempt(true);
  } catch {
    res = await attempt(false);
  }
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      return {
        data: Buffer.from(part.inlineData.data, 'base64'),
        mimeType: part.inlineData.mimeType ?? 'image/png',
      };
    }
  }
  throw new Error('image model returned no image data');
}
