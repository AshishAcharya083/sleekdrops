// Image agent — gives every article a real hero image instead of the empty
// cover fill. Strategy, in order:
//   1. FIND: Tavily image search for the topic/products, download candidates,
//      and vision-check each one (related to the piece? free of watermarks /
//      stock-site overlays / promo text?).
//   2. GENERATE: if nothing usable is found, generate a clean 16:9 editorial
//      hero with the Gemini image model.
// Whatever wins is uploaded to our own GCS bucket and the public URL goes into
// frontmatter (heroImage/heroAlt) — never a hotlink to someone else's server.
//
// This stage degrades, never blocks: any failure returns heroImage null and
// the site keeps rendering its cover-fill fallback.
import { generateImage, visionJson } from '../llm/genai.js';
import { gcsConfigured, uploadPublicImage } from '../tools/gcs.js';
import { tavilyImageSearch } from '../tools/tavily.js';
import type { ArticleRow } from '../pipeline/types.js';

export interface ImageResult {
  heroImage: string | null;
  heroAlt: string | null;
  summary: string;
}

interface VisionVerdict {
  related: boolean;
  watermarkOrOverlay: boolean;
  usableQuality: boolean;
  alt: string;
}

const MIN_BYTES = 25_000; // thumbnails and tracking pixels
const MAX_BYTES = 10_000_000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

async function download(url: string): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SleekDropsBot/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!IMAGE_MIMES.has(mimeType)) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < MIN_BYTES || data.length > MAX_BYTES) return null;
    return { data, mimeType };
  } catch {
    return null;
  }
}

export async function runImageAgent(
  article: ArticleRow,
  visionModel: string,
): Promise<ImageResult> {
  if (!gcsConfigured()) {
    return {
      heroImage: null,
      heroAlt: null,
      summary: 'skipped — GCS_IMAGES_BUCKET not configured; cover fill will render instead',
    };
  }

  const slug = article.slug ?? article.id;
  const title = article.outline?.seoTitle ?? article.title;
  const topProducts = (article.research?.products ?? []).slice(0, 2).map((p) => p.name);

  // ── 1. FIND: search the live web for a clean, related photo ──────────────
  const queries = [
    topProducts.length > 0 ? `${topProducts[0]} product photo` : `${title} photo`,
    `${title}`,
  ];
  let checked = 0;
  for (const query of queries) {
    const hits = await tavilyImageSearch(query).catch(() => []);
    for (const hit of hits.slice(0, 6)) {
      const img = await download(hit.url);
      if (!img) continue;
      checked += 1;
      if (checked > 8) break; // vision checks aren't free — bound the sweep
      try {
        const verdict = await visionJson<VisionVerdict>(visionModel, img, `You are vetting a candidate hero image for an article titled "${title}".
Image search context: "${hit.description || query}".

Return JSON:
{"related": boolean (clearly shows this product/topic),
 "watermarkOrOverlay": boolean (ANY watermark, stock-site stamp, logo overlay, promo text, price tag or UI chrome),
 "usableQuality": boolean (sharp, well-lit, large enough for a 16:9 hero crop),
 "alt": string (concise, factual alt text for the image)}`);
        if (verdict.related && !verdict.watermarkOrOverlay && verdict.usableQuality) {
          const url = await uploadPublicImage(
            `heroes/${slug}.${EXT[img.mimeType]}`,
            img.data,
            img.mimeType,
          );
          return {
            heroImage: url,
            heroAlt: verdict.alt || title,
            summary: `found web image (${hit.url}) → ${url}`,
          };
        }
      } catch {
        continue; // one bad candidate never sinks the stage
      }
    }
  }

  // ── 2. GENERATE: fall back to the image model ────────────────────────────
  try {
    const generated = await generateImage(
      `Photorealistic editorial hero photograph for a consumer product article titled "${title}".
${topProducts.length > 0 ? `Feature: ${topProducts.join(' and ')}.` : ''}
Wide 16:9 composition, natural lighting, clean uncluttered background, magazine quality.
Absolutely NO text, NO logos, NO watermarks, NO people's faces.`,
    );
    const url = await uploadPublicImage(
      `heroes/${slug}.${EXT[generated.mimeType] ?? 'png'}`,
      generated.data,
      generated.mimeType,
    );
    return {
      heroImage: url,
      heroAlt: `Illustrative image: ${title}`,
      summary: `no usable web image (checked ${checked}) — generated one → ${url}`,
    };
  } catch (err) {
    return {
      heroImage: null,
      heroAlt: null,
      summary: `no hero image: web search found nothing usable (checked ${checked}) and generation failed (${err instanceof Error ? err.message : err})`,
    };
  }
}
