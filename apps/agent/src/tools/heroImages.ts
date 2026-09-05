// Operator-supplied hero images — the file an admin drops in the panel when the
// image agent's own pick isn't good enough.
//
// Validation is deliberately strict about what earns a URL in a world-readable
// bucket: the declared content type must be one the website renders AND the
// bytes must actually start with that format's magic number, so a mislabeled
// (or hostile) file can't be served from our own domain as a hero image. SVG is
// not on the list precisely because it can carry script.
import { randomBytes } from 'node:crypto';
import { uploadPublicImage } from './gcs.js';

export const MAX_HERO_IMAGE_BYTES = 10 * 1024 * 1024;

/** The formats the site's <img> heroes render everywhere — no SVG, no HEIC. */
export const HERO_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type HeroImageMime = (typeof HERO_IMAGE_MIMES)[number];

const EXTENSION: Record<HeroImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface HeroImageUpload {
  data: Buffer;
  mimeType: HeroImageMime;
}

export type HeroImageCheck =
  | { ok: true; value: HeroImageUpload }
  | { ok: false; error: string };

/** What the first bytes say the file really is, regardless of its label. */
export function sniffImageMime(data: Buffer): HeroImageMime | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Vet a dropped file. The sniffed format wins over the browser-declared one
 * when both are acceptable — a .jpg that is really a PNG still publishes fine,
 * it just gets the right extension and content type.
 */
export function readHeroImageUpload(declaredType: string, data: Buffer): HeroImageCheck {
  if (data.length === 0) return { ok: false, error: 'the uploaded file is empty' };
  if (data.length > MAX_HERO_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image is ${(data.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_HERO_IMAGE_BYTES / 1024 / 1024} MB`,
    };
  }

  const sniffed = sniffImageMime(data);
  if (!sniffed) {
    const declared = declaredType.split(';')[0].trim().toLowerCase();
    return {
      ok: false,
      error: `unsupported image format${declared ? ` (${declared})` : ''} — use JPEG, PNG or WebP`,
    };
  }
  return { ok: true, value: { data, mimeType: sniffed } };
}

/**
 * Object name for an uploaded hero. The random suffix matters: uploads are
 * stored with a one-year immutable cache header, so replacing an image has to
 * mean a new URL or browsers (and the CDN) would keep serving the old one.
 * The owner id is sanitised because it arrives from a URL path segment.
 */
export function heroImageObjectName(
  scope: 'article' | 'topic',
  ownerId: string,
  mimeType: HeroImageMime,
): string {
  const safeId = ownerId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'unknown';
  return `heroes/uploads/${scope}-${safeId}-${randomBytes(4).toString('hex')}.${EXTENSION[mimeType]}`;
}

/** Upload a vetted image and return the public URL to store on the row. */
export async function storeHeroImage(
  scope: 'article' | 'topic',
  ownerId: string,
  upload: HeroImageUpload,
): Promise<string> {
  return uploadPublicImage(
    heroImageObjectName(scope, ownerId, upload.mimeType),
    upload.data,
    upload.mimeType,
  );
}
