// Supabase Storage upload for article hero images. The bucket is public, so
// the URL returned is readable by anyone - that is how the website's <img>
// tags load it - while uploading needs the project's service-role (or
// `sb_secret_…`) key, which only the agent holds.
import { config } from '../config.js';

export function storageConfigured(): boolean {
  const { url, serviceRoleKey, imagesBucket } = config.supabase;
  return Boolean(url && serviceRoleKey && imagesBucket);
}

/**
 * The request headers that authenticate as the service role. A new-style
 * `sb_secret_…` key goes in `apikey` only - Supabase rejects one sent as a
 * Bearer token, because it is not a JWT - while a legacy service_role key is a
 * JWT and goes in both.
 */
function serviceHeaders(): Record<string, string> {
  const key = config.supabase.serviceRoleKey;
  return key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

/** `object` with each path segment percent-encoded, slashes kept. */
function objectPath(objectName: string): string {
  return objectName.split('/').map(encodeURIComponent).join('/');
}

/** The public URL of an object in the images bucket. */
export function publicImageUrl(objectName: string): string {
  const { url, imagesBucket } = config.supabase;
  return `${url}/storage/v1/object/public/${imagesBucket}/${objectPath(objectName)}`;
}

/**
 * Upload image bytes and return the public URL to store in frontmatter. An
 * object that already exists under the name is replaced, as the image stage
 * expects when it re-runs for the same slug.
 */
export async function uploadPublicImage(
  objectName: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  if (!storageConfigured()) {
    throw new Error(
      'Supabase Storage is not configured — need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to upload hero images',
    );
  }
  const { url, imagesBucket } = config.supabase;
  const res = await fetch(`${url}/storage/v1/object/${imagesBucket}/${objectPath(objectName)}`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(),
      'Content-Type': contentType,
      'cache-control': 'max-age=31536000',
      'x-upsert': 'true',
    },
    body: new Uint8Array(data),
  });
  if (!res.ok) {
    // The body is Storage's own error ({statusCode, error, message}); it never
    // echoes the key.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Supabase Storage upload of ${objectName} failed (HTTP ${res.status}): ${detail}`);
  }
  return publicImageUrl(objectName);
}
