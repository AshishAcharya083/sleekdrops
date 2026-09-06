// Google Cloud Storage upload for article hero images. Auth is ADC — the
// Cloud Run service account in production, `gcloud auth application-default
// login` locally. The bucket itself must grant allUsers Storage Object Viewer
// (uniform bucket-level access) so the returned URL is publicly readable.
import { Storage } from '@google-cloud/storage';
import { config } from '../config.js';

let storage: Storage | null = null;

export function gcsConfigured(): boolean {
  return Boolean(config.gcs.imagesBucket);
}

/** Upload image bytes and return the public URL to store in frontmatter. */
export async function uploadPublicImage(
  objectName: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  if (!gcsConfigured()) {
    throw new Error('GCS_IMAGES_BUCKET is not set — cannot upload hero images');
  }
  storage ??= new Storage();
  const file = storage.bucket(config.gcs.imagesBucket).file(objectName);
  await file.save(data, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
  });
  // Uniform bucket-level access rejects per-object ACLs — the bucket policy
  // already makes it public there, so a 400 here is expected and fine.
  await file.makePublic().catch(() => {});
  return `${config.gcs.publicBase}/${config.gcs.imagesBucket}/${objectName}`;
}
