// Cloudflare R2 upload for article hero images, via the S3-compatible API.
// Credentials come from an R2 API token (Account → R2 → Object Read & Write).
// The bucket must expose a public domain (an R2 custom domain or the managed
// r2.dev subdomain) so the returned URL is publicly readable.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

let client: S3Client | null = null;

export function r2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey, bucket, publicBase } = config.r2;
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket && publicBase);
}

function r2Client(): S3Client {
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  return client;
}

/** Upload image bytes under `key` and return the public URL for frontmatter. */
export async function uploadPublicImage(
  key: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  if (!r2Configured()) {
    throw new Error(
      'Cloudflare R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL',
    );
  }
  await r2Client().send(
    new PutObjectCommand({
      Bucket: config.r2.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return `${config.r2.publicBase}/${key}`;
}
