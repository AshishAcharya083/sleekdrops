// Copies PeakOdds' published posts from its Supabase project into
// .content-cache/posts.json, where src/lib/posts.ts reads them during the
// build. Run by the dev and prebuild scripts; safe to re-run.
//
// Env vars (apps/peakodds/.env locally, repository variables in CI):
//   PEAKODDS_SUPABASE_URL              - https://<project-ref>.supabase.co
//   PEAKODDS_SUPABASE_PUBLISHABLE_KEY  - the project's publishable key

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentSourceFromEnv, fetchPublishedPosts } from '../src/lib/fetch-published-posts.ts';
import { CONTENT_CACHE_FILE, parsePostRows } from '../src/lib/posts.ts';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const envFile = resolve(APP_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const rows = await fetchPublishedPosts(contentSourceFromEnv(process.env));
  // Checked here as well as in the build so a post with no edition, or an
  // unknown one, stops the deploy before Astro starts, naming the post.
  const posts = parsePostRows(rows);

  const cacheFile = resolve(APP_ROOT, CONTENT_CACHE_FILE);
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(rows), 'utf8');
  console.log(`[fetch-content] wrote ${CONTENT_CACHE_FILE} (published posts: ${posts.length})`);
} catch (error) {
  console.error(`\n[fetch-content] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
