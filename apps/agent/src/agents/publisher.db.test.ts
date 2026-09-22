// What the publisher is allowed to overwrite in D1, and what it must only ever
// do once.
//
// `affiliate_links` is one site-wide slug → destination map, and a product
// slug is deterministic (normaliseDossier slugifies the product name), so two
// articles covering the same product write the same row. A row healed out of
// one draft's own words - no dossier product, no verified ASIN - must not
// replace the row another article resolved properly, or the readers of a piece
// that is already published start landing on a search page instead of the
// product page they had.
//
// Publish is also re-entrant now - a retry-forward run comes back through it,
// as does a republish - so the second half of this file is about the parts of a
// publish that are only true the first time: the publication date the site
// prints, and the rebuild dispatch.
//
// The D1 REST call is stubbed; the SQL the publisher builds is the subject.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
process.env.GITHUB_TOKEN = 'test-github-token';

const { getSetting, pool, q, setSetting } = await import('../db/pool.js');
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
const created: string[] = [];
after(async () => {
  globalThis.fetch = realFetch;
  if (reachable && created.length > 0) {
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  }
  if (reachable) await pool.end();
});

interface D1Capture {
  /** Every statement the publisher sent to D1, in order. */
  statements: Array<{ sql: string; params: unknown[] }>;
  /** How many site rebuilds it asked GitHub for. */
  dispatches: number;
}

function captureD1(): D1Capture {
  const capture: D1Capture = { statements: [], dispatches: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('api.cloudflare.com')) {
      capture.statements.push(JSON.parse(String(init?.body)) as { sql: string; params: unknown[] });
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    // The content-updated repository dispatch.
    capture.dispatches += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return capture;
}

/** The posts upsert out of one capture, with its bound parameters. */
function postsWrite(capture: D1Capture): { sql: string; params: unknown[] } {
  return capture.statements.find((statement) => statement.sql.includes('INSERT INTO posts'))!;
}

const PUB_DATE_PARAM = 6;

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

const BODY = 'The [Sony WH-1000XM6](/go/sony-wh-1000xm6) is the one.';

/** A real row, because the publisher now reads and stamps its own columns. */
async function article(links: AffiliateLinkRow[], fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status,
                           draft_md, frontmatter, affiliate_links, seo_review)
     VALUES ($1, $2, 'Tech', 'guide', 'publish', 'queued', $3, $4::jsonb, $5::jsonb, $6::jsonb)
     RETURNING *`,
    [
      'The headphones for a quiet commute',
      `quiet-commutes-${randomUUID().slice(0, 8)}`,
      fields.draft_md ?? BODY,
      JSON.stringify(
        fields.frontmatter ?? {
          title: 'The headphones for a quiet commute',
          author: 'desk',
          pubDate: '2026-09-14',
        },
      ),
      JSON.stringify(links),
      fields.seo_review === undefined ? null : JSON.stringify(fields.seo_review),
    ],
  );
  created.push(row.id);
  return row;
}

/** The stored publication date, formatted in SQL: `pg` reads a DATE back at
 *  local midnight, so a timezone ahead of UTC would shift it here. */
async function storedPubDate(id: string): Promise<string | null> {
  const [row] = await q<{ pub_date: string | null }>(
    "SELECT to_char(pub_date, 'YYYY-MM-DD') pub_date FROM articles WHERE id = $1",
    [id],
  );
  return row.pub_date;
}

/** Re-read the row the way the worker would on the next pass. */
async function reload(id: string): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]);
  return row;
}

test('a healed row only fills a slug nothing has claimed', { skip }, async () => {
  const capture = captureD1();
  await runPublisher(await article([healed]));

  const affiliate = capture.statements[0].sql;
  assert.match(affiliate, /INSERT INTO affiliate_links/);
  assert.match(affiliate, /ON CONFLICT \(slug\) DO NOTHING/);
  assert.doesNotMatch(affiliate, /DO UPDATE/);
});

test('a dossier-backed row still refreshes the destination it owns', { skip }, async () => {
  const capture = captureD1();
  await runPublisher(await article([resolved]));

  const affiliate = capture.statements[0].sql;
  assert.match(affiliate, /ON CONFLICT \(slug\) DO UPDATE SET/);
  assert.match(affiliate, /default_url = excluded\.default_url/);
  assert.match(affiliate, /regions_json = excluded\.regions_json/);
});

// ── Re-entry ───────────────────────────────────────────────────────────────
// Retry-forward re-enters publish. The D1 writes were always slug upserts, so
// the live row is genuinely idempotent; what was not idempotent is everything
// that is only true the first time.

test('publish entered twice leaves one live post and one rebuild', { skip }, async () => {
  const row = await article([resolved]);
  const first = captureD1();
  const published = await runPublisher(row);

  assert.equal(published.dispatched, true);
  assert.equal(first.dispatches, 1);
  const firstWrite = postsWrite(first);
  assert.match(firstWrite.sql, /ON CONFLICT \(slug\) DO UPDATE SET/);

  // Second pass over unchanged content, on the row as the worker re-reads it.
  const second = captureD1();
  const again = await runPublisher(await reload(row.id));

  assert.equal(again.dispatched, false, 'a repeat pass must not rebuild the site again');
  assert.equal(second.dispatches, 0);
  // Still one live row: the same slug, upserted, not a second insert.
  const secondWrite = postsWrite(second);
  assert.equal(secondWrite.params[0], row.slug);
  assert.match(secondWrite.sql, /ON CONFLICT \(slug\) DO UPDATE SET/);
  assert.equal(secondWrite.params[PUB_DATE_PARAM], firstWrite.params[PUB_DATE_PARAM]);
});

test('a repeat pass never re-stamps the publication date', { skip }, async () => {
  const first = captureD1();
  const row = await article([resolved]);
  await runPublisher(row);
  assert.equal(postsWrite(first).params[PUB_DATE_PARAM], '2026-09-14');
  assert.equal(await storedPubDate(row.id), '2026-09-14');

  // A later pass whose frontmatter carries a newer date: the stored one wins,
  // because a reader must not see the publication date move under a retry.
  await q(`UPDATE articles SET frontmatter = frontmatter || '{"pubDate": "2026-10-01"}'::jsonb
            WHERE id = $1`, [row.id]);
  const second = captureD1();
  await runPublisher(await reload(row.id));

  assert.equal(postsWrite(second).params[PUB_DATE_PARAM], '2026-09-14');
  assert.equal(await storedPubDate(row.id), '2026-09-14');
});

test('a publish of genuinely new content rebuilds the site again', { skip }, async () => {
  const row = await article([resolved]);
  captureD1();
  await runPublisher(row);

  await q("UPDATE articles SET draft_md = draft_md || ' Updated after an edit pass.' WHERE id = $1", [
    row.id,
  ]);
  const second = captureD1();
  const again = await runPublisher(await reload(row.id));

  assert.equal(again.dispatched, true);
  assert.equal(second.dispatches, 1);
});

test('a failed dispatch is retried rather than recorded as delivered', { skip }, async () => {
  const row = await article([resolved]);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('api.cloudflare.com')) {
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    return new Response('rate limited', { status: 429 });
  }) as typeof fetch;

  await assert.rejects(runPublisher(row), /repository_dispatch failed/);
  assert.equal((await reload(row.id)).published_digest, null, 'nothing was marked as pushed live');

  const retry = captureD1();
  assert.equal((await runPublisher(await reload(row.id))).dispatched, true);
  assert.equal(retry.dispatches, 1);
});

test('a stale review stops the publish even when it was already queued', { skip }, async () => {
  const row = await article([resolved], { seo_review: { score: 80, pass: true, issues: [] } });
  const session = async (agent: string, minutesAgo: number) =>
    q(
      `INSERT INTO agent_sessions (article_id, agent, status, kind, started_at, ended_at)
       VALUES ($1, $2, 'done', 'pipeline', now() - make_interval(mins => $3 + 1),
               now() - make_interval(mins => $3))`,
      [row.id, agent, minutesAgo],
    );
  await session('seo_reviewer', 20);
  // A retry regenerated the draft after the review that approved it.
  await session('writer', 5);

  const capture = captureD1();
  await assert.rejects(
    runPublisher(await reload(row.id)),
    /seo_review is out of date - the draft changed after the last review\. Re-run seo_review before publishing\./,
  );
  assert.equal(capture.statements.length, 0, 'nothing reached D1');
  assert.equal(capture.dispatches, 0);
});

test('parking a post as a draft and publishing it again rebuilds the site', { skip }, async () => {
  const row = await article([resolved]);
  captureD1();
  await runPublisher(row);

  const mode = await getSetting<string>('publish_mode', 'approval');
  try {
    await setSetting('publish_mode', 'draft');
    const parked = captureD1();
    assert.equal((await runPublisher(await reload(row.id))).d1Status, 'draft');
    assert.equal(parked.dispatches, 0, 'a draft pass never rebuilds the site');

    await setSetting('publish_mode', mode === 'draft' ? 'approval' : mode);
    const relive = captureD1();
    // The text has not changed, but the live row has: it went from draft back
    // to published, and the site has to be rebuilt to carry it again.
    assert.equal((await runPublisher(await reload(row.id))).dispatched, true);
    assert.equal(relive.dispatches, 1);
  } finally {
    await setSetting('publish_mode', mode);
  }
});
