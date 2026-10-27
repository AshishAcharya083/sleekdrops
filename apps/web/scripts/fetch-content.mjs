// Fetch editorial content from Supabase at build time. Published posts →
// src/content/blog/*.md, affiliate links → .content-cache/affiliate-links.json
// where generate-redirects.mjs reads them.
//
// Content lives in two tables of the SleekDrops Supabase project, written by
// the agent platform's publisher (apps/agent/src/db/migrations/019_content_store.sql):
//   posts(slug, status, …, frontmatter_json, body_md)   — status='published' is live
//   affiliate_links(slug, default_url, regions_json, note, expires_at)
// They were Cloudflare D1 tables until October 2026; the columns are the same.
//
// Read through Supabase's Data API with the project's publishable key. That
// key is public by design - row-level security lets it read published posts
// and the affiliate links and nothing else - so the build needs no secret.
//
// Run by prebuild and dev scripts; idempotent and safe to re-run.
//
// Env vars (set in .env locally, repository variables in CI):
//   SUPABASE_URL              — https://<project-ref>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  — the project's publishable (or legacy anon) key

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArticleBody } from '../src/lib/content-normalize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CACHE = resolve(ROOT, '.content-cache');
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

// `||` not `??`: CI sets unset variables to empty strings, which must count as unset.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

if (!SUPABASE_URL || !KEY) {
  fail(
    'Missing env. Need SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY. Locally: copy ' +
      '.env.example to .env and fill in the Supabase section.',
  );
}

/** Rows per request. Supabase caps a Data API response at 1,000 by default. */
const PAGE = 1000;

/**
 * Every row of `table` the publishable key may read, in `order`, a page at a
 * time. `filters` is the Data API query string (`status=eq.published`).
 */
async function selectAll(table, columns, order, filters = '') {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = [`select=${columns}`, filters, `order=${order}`, `limit=${PAGE}`, `offset=${offset}`]
      .filter(Boolean)
      .join('&');
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
        headers: { apikey: KEY, Accept: 'application/json' },
      });
    } catch (err) {
      fail(`Supabase unreachable reading ${table}: ${err.message}`);
    }
    const body = await res.text();
    if (!res.ok) fail(`Supabase query on ${table} failed (HTTP ${res.status}): ${body}`);
    const page = JSON.parse(body);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/** A JSON column: an object from the Data API (JSONB), or text from an older export. */
function jsonValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// ---------------------------------------------------------------------------
// Frontmatter serialization. frontmatter_json holds the full frontmatter as
// JSON; JSON scalars/arrays/objects are all valid YAML, so each value can be
// emitted with JSON.stringify — no YAML library needed, no escaping bugs.
// ---------------------------------------------------------------------------
function toFrontmatterYaml(fmJson) {
  const fm = jsonValue(fmJson);
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

const posts = await selectAll('posts', 'slug,frontmatter_json,body_md', 'slug.asc', 'status=eq.published');
const links = await selectAll('affiliate_links', 'slug,default_url,regions_json,note', 'slug.asc');

const linkSlugs = new Set(links.map((l) => l.slug));
const errors = [];

if (existsSync(BLOG_TARGET)) rmSync(BLOG_TARGET, { recursive: true, force: true });
mkdirSync(BLOG_TARGET, { recursive: true });

for (const post of posts) {
  const body = normalizeArticleBody(post.body_md);
  if (RAW_MERCHANT.test(body)) {
    errors.push(`${post.slug}: body contains a raw merchant URL — use /go/<slug> instead.`);
  }
  for (const m of body.matchAll(GO_LINK)) {
    if (!linkSlugs.has(m[1])) {
      errors.push(`${post.slug}: /go/${m[1]} has no matching row in affiliate_links.`);
    }
  }
  writeFileSync(
    resolve(BLOG_TARGET, `${post.slug}.md`),
    `${toFrontmatterYaml(post.frontmatter_json)}\n\n${body.trim()}\n`,
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
    ...(l.regions_json ? jsonValue(l.regions_json) : {}),
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
log(`wrote ${links.length} affiliate link(s) → .content-cache/affiliate-links.json`);
