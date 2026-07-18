// Image agent — gives every article a real product hero image instead of the
// bare gradient cover fill. Strategy:
//   FIND: Tavily image search for the product/topic, download candidates, and
//   vision-check each one — does it actually show the product, is it free of
//   watermarks / stock-site stamps / promo overlays, is it sharp enough for a
//   16:9 hero? The first clean, product-showing candidate wins.
// The winner is resized to a ~1600px 16:9 JPEG (EXIF stripped) and uploaded to
// our own Cloudflare R2 bucket under posts/{YYYY}/{MM}/{slug}/hero.jpg; the
// public URL goes into frontmatter (heroImage/heroAlt) — never a hotlink to
// someone else's server.
//
// This stage degrades, never blocks: any failure returns heroImage null and
// the site keeps rendering its gradient cover fallback.
import sharp from 'sharp';
import { visionJson } from '../llm/genai.js';
import { r2Configured, uploadPublicImage } from '../tools/r2.js';
import { tavilyImageSearch } from '../tools/tavily.js';
import type { ArticleRow } from '../pipeline/types.js';

export interface ImageResult {
  heroImage: string | null;
  heroAlt: string | null;
  summary: string;
}

interface VisionVerdict {
  showsProduct: boolean;
  watermarkOrOverlay: boolean;
  usableQuality: boolean;
  alt: string;
}

const MIN_BYTES = 25_000; // thumbnails and tracking pixels
const MAX_BYTES = 10_000_000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const HERO_WIDTH = 1600;
const HERO_HEIGHT = 900; // 16:9
const MAX_VISION_CHECKS = 8; // vision calls aren't free — bound the sweep

/** Object key for an article's hero image: posts/{YYYY}/{MM}/{slug}/hero.jpg. */
export function heroKey(slug: string, isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `posts/${yyyy}/${mm}/${slug}/hero.jpg`;
}

/**
 * Downscale/crop any candidate to the web hero format: 1600x900 JPEG, quality
 * ~80, auto-oriented and stripped of EXIF (sharp drops metadata by default).
 */
export async function resizeToHero(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate() // apply EXIF orientation before the metadata is dropped
    .resize(HERO_WIDTH, HERO_HEIGHT, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

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
  if (!r2Configured()) {
    return {
      heroImage: null,
      heroAlt: null,
      summary: 'skipped — Cloudflare R2 not configured; gradient cover will render instead',
    };
  }

  const slug = article.slug ?? article.id;
  const title = article.outline?.seoTitle ?? article.title;
  const topProducts = (article.research?.products ?? []).slice(0, 2).map((p) => p.name);
  const fm = article.frontmatter ?? {};
  const pubDate =
    typeof fm.pubDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.pubDate)
      ? fm.pubDate
      : new Date().toISOString().slice(0, 10);

  const queries = [
    topProducts.length > 0 ? `${topProducts[0]} official product photo` : `${title} product photo`,
    topProducts.length > 1 ? `${topProducts[1]} product photo` : `${title}`,
  ];

  let checked = 0;
  for (const query of queries) {
    const hits = await tavilyImageSearch(query).catch(() => []);
    for (const hit of hits.slice(0, 6)) {
      if (checked >= MAX_VISION_CHECKS) break;
      const img = await download(hit.url);
      if (!img) continue;
      checked += 1;
      try {
        const verdict = await visionJson<VisionVerdict>(
          visionModel,
          img,
          `You are vetting a candidate hero image for an article titled "${title}".
Image search context: "${hit.description || query}".
Prefer clean official brand or retailer product shots of the actual product.

Return JSON:
{"showsProduct": boolean (clearly shows THIS product/topic, not a generic lifestyle or unrelated stock photo),
 "watermarkOrOverlay": boolean (ANY watermark, stock-site stamp, logo overlay, promo text, price tag or UI chrome),
 "usableQuality": boolean (sharp, well-lit, large enough for a 16:9 hero crop),
 "alt": string (concise, factual alt text for the image)}`,
        );
        if (verdict.showsProduct && !verdict.watermarkOrOverlay && verdict.usableQuality) {
          const hero = await resizeToHero(img.data);
          const url = await uploadPublicImage(heroKey(slug, pubDate), hero, 'image/jpeg');
          return {
            heroImage: url,
            heroAlt: verdict.alt || title,
            summary: `found product image (${hit.url}) → ${url}`,
          };
        }
      } catch {
        continue; // one bad candidate never sinks the stage
      }
    }
    if (checked >= MAX_VISION_CHECKS) break;
  }

  return {
    heroImage: null,
    heroAlt: null,
    summary: `no hero image: checked ${checked} candidate(s), none were clean product shots — gradient cover will render`,
  };
}
