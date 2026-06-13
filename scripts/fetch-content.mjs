// Fetch editorial content from Cloudflare D1 (database: sleekdrops-content)
// at build time. Published posts → src/content/blog/*.md, affiliate links →
// .d1-cache/affiliate-links.json where generate-redirects.mjs reads them.
//
// Replaces the old sleekdrops-cms git-clone flow (decommissioned 2026-06-13).
// Content now lives in two D1 tables:
//   posts(slug, status, …, frontmatter_json, body_md)   — status='published' is live
//   affiliate_links(slug, default_url, regions_json, note, expires_at)
//
// Run by prebuild and dev scripts; idempotent and safe to re-run.
//
// Env vars (set in .env locally, GitHub secrets in CI):
//   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account id
//   D1_DATABASE_ID          — sleekdrops-content database id (not secret)
//   CLOUDFLARE_D1_TOKEN     — API token with "Account → D1 → Read" permission
//                             (falls back to CLOUDFLARE_API_TOKEN if unset)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE = resolve(ROOT, '.d1-cache');
const BLOG_TARGET = resolve(ROOT, 'src/content/blog');

function log(msg) {
  console.log(`[fetch-content] ${msg}`);
}

function fail(msg) {
  console.error(`\n[fetch-content] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal .env loader (no dependency): KEY=VALUE lines, # comments allowed.
// Real env vars always win over .env values.
// ---------------------------------------------------------------------------
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const DATABASE_ID = process.env.D1_DATABASE_ID;
// `||` not `??`: CI sets unset secrets to empty strings, which must fall back.
const TOKEN = process.env.CLOUDFLARE_D1_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !DATABASE_ID || !TOKEN) {
  fail(
    'Missing env. Need CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and ' +
      'CLOUDFLARE_D1_TOKEN (or CLOUDFLARE_API_TOKEN). Locally: copy ' +
      '.env.example to .env and fill in the D1 section.',
  );
}

async function queryD1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) {
    fail(`D1 query failed (HTTP ${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result[0].results;
}

// ---------------------------------------------------------------------------
// Frontmatter serialization. frontmatter_json holds the full frontmatter as
// JSON; JSON scalars/arrays/objects are all valid YAML, so each value can be
// emitted with JSON.stringify — no YAML library needed, no escaping bugs.
// ---------------------------------------------------------------------------
function toFrontmatterYaml(fmJson) {
  const fm = JSON.parse(fmJson);
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Guardrails previously enforced by sleekdrops-cms's `pnpm validate`. The
// Astro content collection still Zod-validates frontmatter; these two checks
// cover the post BODY rules and fail the build on violation.
// ---------------------------------------------------------------------------
const RAW_MERCHANT = /(amazon\.[a-z.]+\/(dp|gp\/product)\/|amzn\.to\/|[?&]tag=)/i;
const GO_LINK = /\/go\/([a-z0-9]+(?:-[a-z0-9]+)*)/g;

const posts = await queryD1(
  "SELECT slug, frontmatter_json, body_md FROM posts WHERE status = 'published' ORDER BY slug",
);
const links = await queryD1(
  'SELECT slug, default_url, regions_json, note FROM affiliate_links ORDER BY slug',
);

const linkSlugs = new Set(links.map((l) => l.slug));
const errors = [];

if (existsSync(BLOG_TARGET)) rmSync(BLOG_TARGET, { recursive: true, force: true });
mkdirSync(BLOG_TARGET, { recursive: true });

for (const post of posts) {
  if (RAW_MERCHANT.test(post.body_md)) {
    errors.push(`${post.slug}: body contains a raw merchant URL — use /go/<slug> instead.`);
  }
  for (const m of post.body_md.matchAll(GO_LINK)) {
    if (!linkSlugs.has(m[1])) {
      errors.push(`${post.slug}: /go/${m[1]} has no matching row in affiliate_links.`);
    }
  }
  writeFileSync(
    resolve(BLOG_TARGET, `${post.slug}.md`),
    `${toFrontmatterYaml(post.frontmatter_json)}\n\n${post.body_md.trim()}\n`,
    'utf8',
  );
}

if (errors.length > 0) {
  fail(`content guardrails failed:\n  - ${errors.join('\n  - ')}`);
}

// Legacy-shaped affiliate-links.json for generate-redirects.mjs.
const linksOut = {};
for (const l of links) {
  linksOut[l.slug] = {
    default: l.default_url,
    ...(l.regions_json ? JSON.parse(l.regions_json) : {}),
    ...(l.note ? { note: l.note } : {}),
  };
}
mkdirSync(CACHE, { recursive: true });
writeFileSync(
  resolve(CACHE, 'affiliate-links.json'),
  JSON.stringify({ links: linksOut }, null, 2),
  'utf8',
);

log(`wrote ${posts.length} published post(s) → src/content/blog/`);
log(`wrote ${links.length} affiliate link(s) → .d1-cache/affiliate-links.json`);
