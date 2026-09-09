#!/usr/bin/env node
// Submits the URLs that changed in this build to IndexNow, after the production
// deploy (see .github/workflows/deploy-production.yml).
//
// Reads the sitemap Astro just wrote into dist/, keeps the entries whose
// `lastmod` falls inside the window, and POSTs them once to api.indexnow.org,
// which fans the submission out to Bing, Yandex, Naver, Seznam, Yep and Amazon.
// The key it presents is the one `public/indexnow-key.txt` ships at the site
// root - IndexNow fetches that file to confirm we own the host.
//
//   node scripts/indexnow-submit.mjs                  # last 36 hours, from SITE_URL
//   node scripts/indexnow-submit.mjs --since-hours 6
//   node scripts/indexnow-submit.mjs --all            # every URL with a lastmod
//   node scripts/indexnow-submit.mjs --dry-run        # print, do not send
//
// Exit 0 when there is nothing to send or the engines accepted (200/202); exit 1
// on any other response so the workflow step shows the failure. The deploy has
// already succeeded by the time this runs, and the step is `continue-on-error`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEXNOW_ENDPOINT,
  KEY_FILE,
  buildSubmission,
  isValidKey,
  parseSitemapIndex,
  parseSitemapUrls,
  selectChangedUrls,
} from '../src/lib/indexnow.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const siteUrl = (process.env.SITE_URL ?? 'https://sleekdrops.com').trim().replace(/\/+$/, '');
const sinceHours = Number(option('--since-hours', '36'));
const dryRun = flag('--dry-run');
const all = flag('--all');

function fail(message) {
  console.error(`[indexnow] ${message}`);
  process.exit(1);
}

const keyPath = resolve(DIST, KEY_FILE);
if (!existsSync(keyPath)) fail(`missing ${keyPath} - was the site built, and is public/${KEY_FILE} present?`);
const key = readFileSync(keyPath, 'utf8').trim();
if (!isValidKey(key)) fail(`public/${KEY_FILE} does not hold a valid IndexNow key (8-128 of [A-Za-z0-9-]).`);

// The sitemap files, from the index Astro writes; a single sitemap-0.xml is the
// usual case, but a site past the integration's entry limit gets several.
const indexPath = resolve(DIST, 'sitemap-index.xml');
const sitemapFiles = existsSync(indexPath)
  ? parseSitemapIndex(readFileSync(indexPath, 'utf8')).map((loc) => resolve(DIST, new URL(loc).pathname.slice(1)))
  : [resolve(DIST, 'sitemap-0.xml')];

const entries = sitemapFiles.flatMap((file) => {
  if (!existsSync(file)) {
    console.warn(`[indexnow] sitemap listed but not built: ${file}`);
    return [];
  }
  return parseSitemapUrls(readFileSync(file, 'utf8'));
});

const urls = all
  ? entries.filter((entry) => entry.lastmod).map((entry) => entry.loc)
  : selectChangedUrls(entries, { now: new Date(), sinceHours });

if (urls.length === 0) {
  console.log(`[indexnow] nothing changed in the last ${sinceHours}h (${entries.length} URLs in the sitemap) - nothing to submit.`);
  process.exit(0);
}

const submission = buildSubmission({ siteUrl, key, urls });
console.log(`[indexnow] ${dryRun ? 'would submit' : 'submitting'} ${submission.urlList.length} URL(s) for ${submission.host}:`);
submission.urlList.forEach((url) => console.log(`  ${url}`));
if (dryRun) process.exit(0);

let response;
try {
  response = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(submission),
  });
} catch (error) {
  fail(`request failed: ${error instanceof Error ? error.message : String(error)}`);
}

// 200 = received, 202 = received, key validation pending. Anything else is a
// problem with the key, the payload or the host and is worth a red step.
if (response.status === 200 || response.status === 202) {
  console.log(`[indexnow] accepted (HTTP ${response.status}).`);
  process.exit(0);
}
fail(`rejected with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
