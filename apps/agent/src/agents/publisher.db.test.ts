// What the publisher is allowed to overwrite in D1.
//
// `affiliate_links` is one site-wide slug → destination map, and a product
// slug is deterministic (normaliseDossier slugifies the product name), so two
// articles covering the same product write the same row. A row healed out of
// one draft's own words - no dossier product, no verified ASIN - must not
// replace the row another article resolved properly, or the readers of a piece
// that is already published start landing on a search page instead of the
// product page they had.
//
// The D1 REST call is stubbed; the SQL the publisher builds is the subject.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
process.env.GITHUB_TOKEN = 'test-github-token';

const { pool } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { runPublisher } = await import('./publisher.js');

import type { AffiliateLinkRow, ArticleRow } from '../pipeline/types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) await pool.end();
});

/** Every statement the publisher sent to D1, in order. */
function captureD1(): string[] {
  const statements: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('api.cloudflare.com')) {
      statements.push((JSON.parse(String(init?.body)) as { sql: string }).sql);
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    // The content-updated repository dispatch.
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return statements;
}

const resolved: AffiliateLinkRow = {
  slug: 'sony-wh-1000xm6',
  default_url: 'https://www.amazon.com.au/s?k=Sony%20WH-1000XM6',
  regions_json: { network: 'amazon', search: 'Sony WH-1000XM6', asins: { au: 'B0DGHJKL12' } },
  note: 'Sony WH-1000XM6 — ASIN B0DGHJKL12 (au, verified 2026-09-14), used by best-anc-headphones',
};

const healed: AffiliateLinkRow = {
  slug: 'sony-wh-1000xm6',
  default_url: 'https://www.amazon.com.au/s?k=Sony%20WH-1000XM6',
  regions_json: { network: 'amazon', search: 'Sony WH-1000XM6' },
  healed: true,
  note: 'Sony WH-1000XM6 - healed from anchor text, no dossier product behind it, used by quiet-commutes',
};

function article(links: AffiliateLinkRow[]): ArticleRow {
  return {
    slug: 'quiet-commutes',
    title: 'The headphones for a quiet commute',
    category: 'Tech',
    post_type: 'guide',
    frontmatter: { title: 'The headphones for a quiet commute', author: 'desk', pubDate: '2026-09-14' },
    draft_md: 'The [Sony WH-1000XM6](/go/sony-wh-1000xm6) is the one.',
    affiliate_links: links,
  } as unknown as ArticleRow;
}

test('a healed row only fills a slug nothing has claimed', { skip }, async () => {
  const statements = captureD1();
  await runPublisher(article([healed]));

  const [affiliate] = statements;
  assert.match(affiliate, /INSERT INTO affiliate_links/);
  assert.match(affiliate, /ON CONFLICT \(slug\) DO NOTHING/);
  assert.doesNotMatch(affiliate, /DO UPDATE/);
});

test('a dossier-backed row still refreshes the destination it owns', { skip }, async () => {
  const statements = captureD1();
  await runPublisher(article([resolved]));

  const [affiliate] = statements;
  assert.match(affiliate, /ON CONFLICT \(slug\) DO UPDATE SET/);
  assert.match(affiliate, /default_url = excluded\.default_url/);
  assert.match(affiliate, /regions_json = excluded\.regions_json/);
});
