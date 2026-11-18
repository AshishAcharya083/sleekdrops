// @ts-check
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Static output, uploaded to Cloudflare Pages as a plain build.
export default defineConfig({
  // The origin canonical URLs are built from. Unset, BaseLayout fails the
  // page rather than publish a canonical URL on the wrong host.
  site: process.env.PEAKODDS_SITE_URL || undefined,
  output: 'static',
  // `file` writes au/<slug>.html rather than au/<slug>/index.html, so the URL
  // Cloudflare Pages serves is the slash-less one the canonical tag names
  // instead of a redirect to /au/<slug>/.
  build: { format: 'file' },
  trailingSlash: 'never',
});
