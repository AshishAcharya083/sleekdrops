// Fetch the editorial content from sleekdrops-cms into the main repo at
// build time. Posts → src/content/blog/, affiliate-links.json stays at
// .cms-cache/data/affiliate-links.json where generate-redirects.mjs reads it.
//
// Run by prebuild and dev scripts; idempotent and safe to re-run.
//
// Env vars:
//   CMS_REPO_URL   — e.g. https://x-access-token:${PAT}@github.com/DevMahisaur/sleekdrops-cms.git
//                    or git@github.com:DevMahisaur/sleekdrops-cms.git
//   CMS_REPO_REF   — branch or tag to fetch (default: main)
//
// Both have sensible defaults for local dev (uses your existing git auth).

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE = resolve(ROOT, '.cms-cache');
const BLOG_TARGET = resolve(ROOT, 'src/content/blog');

const REPO =
  process.env.CMS_REPO_URL ??
  'https://github.com/DevMahisaur/sleekdrops-cms.git';
const REF = process.env.CMS_REPO_REF ?? 'main';

function log(msg) {
  console.log(`[fetch-content] ${msg}`);
}

function fail(msg) {
  console.error(`\n[fetch-content] ${msg}\n`);
  process.exit(1);
}

if (existsSync(CACHE)) rmSync(CACHE, { recursive: true, force: true });

try {
  execSync(
    `git clone --depth 1 --branch ${REF} ${REPO} ${CACHE}`,
    { stdio: 'inherit' },
  );
} catch (err) {
  fail(`clone failed: ${err.message}\nSet CMS_REPO_URL to a URL with credentials if the repo is private.`);
}

const postsSource = resolve(CACHE, 'posts');
if (!existsSync(postsSource)) {
  fail(`expected ${postsSource} in cloned repo but it doesn't exist`);
}

if (existsSync(BLOG_TARGET)) rmSync(BLOG_TARGET, { recursive: true, force: true });
mkdirSync(BLOG_TARGET, { recursive: true });

const postFiles = readdirSync(postsSource).filter((f) => f.endsWith('.md'));
for (const file of postFiles) {
  cpSync(resolve(postsSource, file), resolve(BLOG_TARGET, file));
}

log(`copied ${postFiles.length} post(s) → src/content/blog/`);
log(`affiliate-links.json available at .cms-cache/data/affiliate-links.json`);
