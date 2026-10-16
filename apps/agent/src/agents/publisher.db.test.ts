// What the publisher is allowed to overwrite in the content store, and what it
// must only ever do once.
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
// SleekDrops' content store is the test database itself (its publish target
// names DATABASE_URL), so these read back the real posts and affiliate_links
// rows. Only the GitHub rebuild dispatch is stubbed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.GITHUB_TOKEN = 'test-github-token';
process.env.GITHUB_REPO = 'example/sleekdrops';
process.env.SITE_URL = 'https://sleekdrops.com';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { cancelArticle } = await import('../pipeline/retry.js');
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
const postSlugs: string[] = [];
const linkSlugs: string[] = [];
after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) {
    if (created.length > 0) await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
    if (postSlugs.length > 0) await q('DELETE FROM posts WHERE slug = ANY($1)', [postSlugs]);
    if (linkSlugs.length > 0) await q('DELETE FROM affiliate_links WHERE slug = ANY($1)', [linkSlugs]);
    await pool.end();
  }
});

interface Dispatches {
  /** How many site rebuilds the publisher asked GitHub for. */
  count: number;
}

/** Answer the content-updated repository dispatch, and count it. */
function captureDispatches(): Dispatches {
  const dispatches: Dispatches = { count: 0 };
  globalThis.fetch = (async () => {
    dispatches.count += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return dispatches;
}

/** A product slug no other test, or an earlier run, has written. */
function productSlug(): string {
  const slug = `sony-wh-1000xm6-${randomUUID().slice(0, 8)}`;
  linkSlugs.push(slug);
  return slug;
}

function resolvedLink(slug: string): AffiliateLinkRow {
  return {
    slug,
    default_url: 'https://www.amazon.com.au/s?k=Sony%20WH-1000XM6',
    regions_json: { network: 'amazon', search: 'Sony WH-1000XM6', asins: { au: 'B0DGHJKL12' } },
    note: 'Sony WH-1000XM6 — ASIN B0DGHJKL12 (au, verified 2026-09-14), used by best-anc-headphones',
  };
}

function healedLink(slug: string): AffiliateLinkRow {
  return {
    slug,
    default_url: 'https://www.amazon.com.au/s?k=Sony%20WH-1000XM6%20healed',
    regions_json: { network: 'amazon', search: 'Sony WH-1000XM6 healed' },
    healed: true,
    note: 'Sony WH-1000XM6 - healed from anchor text, no dossier product behind it, used by quiet-commutes',
  };
}

function bodyFor(link: string): string {
  return `The [Sony WH-1000XM6](/go/${link}) is the one.`;
}

/** A real row, because the publisher now reads and stamps its own columns. */
async function article(links: AffiliateLinkRow[], fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const slug = `quiet-commutes-${randomUUID().slice(0, 8)}`;
  postSlugs.push(slug);
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (platform_id, edition_id, title, slug, category, post_type, stage, status,
                           draft_md, frontmatter, affiliate_links, seo_review)
     VALUES ('sleekdrops', 'au', $1, $2, 'Tech', 'guide', 'publish', 'queued', $3, $4::jsonb, $5::jsonb, $6::jsonb)
     RETURNING *`,
    [
      'The headphones for a quiet commute',
      slug,
      fields.draft_md ?? bodyFor(links[0]?.slug ?? 'nothing'),
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

interface LivePost {
  status: string;
  title: string;
  category: string;
  post_type: string;
  author: string;
  pub_date: string;
  frontmatter_json: Record<string, unknown>;
  body_md: string;
}

/** Every row the site would build for this slug - so "exactly one" can be asserted. */
async function livePosts(slug: string): Promise<LivePost[]> {
  return q<LivePost>(
    `SELECT status, title, category, post_type, author, to_char(pub_date, 'YYYY-MM-DD') pub_date,
            frontmatter_json, body_md
       FROM posts WHERE slug = $1`,
    [slug],
  );
}

async function storedLink(slug: string): Promise<{ default_url: string; regions_json: unknown; note: string | null }> {
  const [row] = await q<{ default_url: string; regions_json: unknown; note: string | null }>(
    'SELECT default_url, regions_json, note FROM affiliate_links WHERE slug = $1',
    [slug],
  );
  return row;
}

test('the post row carries the frontmatter and body the site builds from', { skip }, async () => {
  captureDispatches();
  const link = productSlug();
  const row = await article([resolvedLink(link)]);
  await runPublisher(row);

  const [post] = await livePosts(row.slug!);
  assert.equal(post.status, 'published');
  assert.equal(post.title, 'The headphones for a quiet commute');
  assert.equal(post.category, 'Tech');
  assert.equal(post.post_type, 'guide');
  assert.equal(post.author, 'desk');
  assert.equal(post.pub_date, '2026-09-14');
  // Stored as JSONB, so it reads back as the object it was, not as text.
  assert.deepEqual(post.frontmatter_json, {
    title: 'The headphones for a quiet commute',
    author: 'desk',
    pubDate: '2026-09-14',
  });
  assert.equal(post.body_md, bodyFor(link));
  // The /go/ slug the body links to has its row, or the site build fails.
  assert.deepEqual((await storedLink(link)).regions_json, resolvedLink(link).regions_json);
});

test('a healed row only fills a slug nothing has claimed', { skip }, async () => {
  captureDispatches();
  const link = productSlug();

  // Nothing holds the slug yet: the healed row fills it.
  await runPublisher(await article([healedLink(link)]));
  assert.equal((await storedLink(link)).default_url, healedLink(link).default_url);

  // A properly resolved row takes the slug over...
  await runPublisher(await article([resolvedLink(link)]));
  // ...and a later healed guess for the same product leaves it alone.
  await runPublisher(await article([healedLink(link)]));

  const stored = await storedLink(link);
  assert.equal(stored.default_url, resolvedLink(link).default_url);
  assert.deepEqual(stored.regions_json, resolvedLink(link).regions_json);
  assert.equal(stored.note, resolvedLink(link).note);
});

test('a dossier-backed row still refreshes the destination it owns', { skip }, async () => {
  captureDispatches();
  const link = productSlug();
  await runPublisher(await article([resolvedLink(link)]));

  const refreshed: AffiliateLinkRow = {
    ...resolvedLink(link),
    regions_json: { network: 'amazon', search: 'Sony WH-1000XM6', asins: { au: 'B0DGHJKL12', us: 'B0DGHJKL99' } },
    note: 'Sony WH-1000XM6 — ASINs re-verified 2026-10-01, used by best-anc-headphones',
  };
  await runPublisher(await article([refreshed]));

  const stored = await storedLink(link);
  assert.deepEqual(stored.regions_json, refreshed.regions_json);
  assert.equal(stored.note, refreshed.note);
});

// ── Re-entry ───────────────────────────────────────────────────────────────
// Retry-forward re-enters publish. The content writes were always slug
// upserts, so the live row is genuinely idempotent; what was not idempotent is
// everything that is only true the first time.

test('publish entered twice leaves one live post and one rebuild', { skip }, async () => {
  const row = await article([resolvedLink(productSlug())]);
  const first = captureDispatches();
  const published = await runPublisher(row);

  assert.equal(published.dispatched, true);
  assert.equal(first.count, 1);

  // Second pass over unchanged content, on the row as the worker re-reads it.
  const second = captureDispatches();
  const again = await runPublisher(await reload(row.id));

  assert.equal(again.dispatched, false, 'a repeat pass must not rebuild the site again');
  assert.equal(second.count, 0);
  // Still one live row: the same slug, upserted, not a second insert.
  const posts = await livePosts(row.slug!);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].pub_date, '2026-09-14');
});

test('a repeat pass never re-stamps the publication date', { skip }, async () => {
  captureDispatches();
  const row = await article([resolvedLink(productSlug())]);
  await runPublisher(row);
  assert.equal((await livePosts(row.slug!))[0].pub_date, '2026-09-14');
  assert.equal(await storedPubDate(row.id), '2026-09-14');

  // A later pass whose frontmatter carries a newer date: the stored one wins,
  // because a reader must not see the publication date move under a retry.
  await q(`UPDATE articles SET frontmatter = frontmatter || '{"pubDate": "2026-10-01"}'::jsonb
            WHERE id = $1`, [row.id]);
  await runPublisher(await reload(row.id));

  assert.equal((await livePosts(row.slug!))[0].pub_date, '2026-09-14');
  assert.equal(await storedPubDate(row.id), '2026-09-14');
});

test('a publish of genuinely new content rebuilds the site again', { skip }, async () => {
  const row = await article([resolvedLink(productSlug())]);
  captureDispatches();
  await runPublisher(row);

  await q("UPDATE articles SET draft_md = draft_md || ' Updated after an edit pass.' WHERE id = $1", [
    row.id,
  ]);
  const second = captureDispatches();
  const again = await runPublisher(await reload(row.id));

  assert.equal(again.dispatched, true);
  assert.equal(second.count, 1);
  assert.match((await livePosts(row.slug!))[0].body_md, /Updated after an edit pass\.$/);
});

test('a failed dispatch is retried rather than recorded as delivered', { skip }, async () => {
  const row = await article([resolvedLink(productSlug())]);
  globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;

  await assert.rejects(runPublisher(row), /repository_dispatch failed/);
  assert.equal((await reload(row.id)).published_digest, null, 'nothing was marked as pushed live');

  const retry = captureDispatches();
  assert.equal((await runPublisher(await reload(row.id))).dispatched, true);
  assert.equal(retry.count, 1);
});

test('a stale review stops the publish even when it was already queued', { skip }, async () => {
  const row = await article([resolvedLink(productSlug())], { seo_review: { score: 80, pass: true, issues: [] } });
  const session = async (agent: string, minutesAgo: number) =>
    q(
      `INSERT INTO agent_sessions (platform_id, article_id, agent, status, kind, started_at, ended_at)
       VALUES ('sleekdrops', $1, $2, 'done', 'pipeline', now() - make_interval(mins => $3 + 1),
               now() - make_interval(mins => $3))`,
      [row.id, agent, minutesAgo],
    );
  await session('seo_reviewer', 20);
  // A retry regenerated the draft after the review that approved it.
  await session('writer', 5);

  const dispatches = captureDispatches();
  await assert.rejects(
    runPublisher(await reload(row.id)),
    /seo_review is out of date - the draft changed after the last review\. Re-run seo_review before publishing\./,
  );
  assert.equal((await livePosts(row.slug!)).length, 0, 'nothing reached the site');
  assert.equal(dispatches.count, 0);
});

test('parking a post as a draft and publishing it again rebuilds the site', { skip }, async () => {
  const row = await article([resolvedLink(productSlug())]);
  captureDispatches();
  await runPublisher(row);

  // The draft pass is asked for directly rather than by flipping the
  // `publish_mode` setting: that setting is one global row, every *.db.test.ts
  // file shares this database and `node --test` runs them concurrently, so a
  // suite that flipped it would be flipping it under the pipeline suites too -
  // the image stage reads it to choose between waiting_approval and queued.
  const parked = captureDispatches();
  assert.equal(
    (await runPublisher(await reload(row.id), { publishMode: 'draft' })).postStatus,
    'draft',
  );
  assert.equal(parked.count, 0, 'a draft pass never rebuilds the site');
  assert.equal((await livePosts(row.slug!))[0].status, 'draft');

  const relive = captureDispatches();
  // The text has not changed, but the live row has: it went from draft back to
  // published, and the site has to be rebuilt to carry it again.
  assert.equal((await runPublisher(await reload(row.id))).dispatched, true);
  assert.equal(relive.count, 1);
  assert.equal((await livePosts(row.slug!))[0].status, 'published');
});

// ── Cancel ─────────────────────────────────────────────────────────────────
// Publish is the stage that hangs on an external service, which is when an
// operator reaches for cancel. Nothing the publisher does is an article write
// the claim guard could drop for it - the post goes live and the site is
// rebuilt - so the claim is what it has to read for itself.

/** The claim a worker holds while it runs the publish stage. */
async function claimForPublish(id: string): Promise<ArticleRow> {
  const [claimed] = await q<ArticleRow>(
    `UPDATE articles
        SET status = 'running', claimed_by = 'publish-test-worker/' || gen_random_uuid(),
            claimed_at = now(), heartbeat_at = now(),
            lease_expires_at = now() + interval '5 minutes', updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id],
  );
  return claimed;
}

test('an article cancelled mid-publish never reaches the live site', { skip }, async () => {
  const link = productSlug();
  const row = await claimForPublish((await article([resolvedLink(link)])).id);
  assert.deepEqual(await cancelArticle(row.id), { ok: true, pending: true });

  const dispatches = captureDispatches();
  await assert.rejects(runPublisher(row), /lease lost/);

  assert.equal((await livePosts(row.slug!)).length, 0, 'nothing reached the site');
  assert.equal(await storedLink(link), undefined, 'not even its affiliate link');
  assert.equal(dispatches.count, 0);
  const after = await reload(row.id);
  assert.equal(after.pub_date, null, 'and no publish receipt was stamped on the cancelled row');
  assert.equal(after.published_digest, null);
});

test('a cancel that lands while the content store is answering stops the post going live', { skip }, async () => {
  const row = await claimForPublish((await article([resolvedLink(productSlug())])).id);
  const dispatches = captureDispatches();

  // The operator cancels while the affiliate write is in flight - the window
  // that matters, because the content store is what a wedged publish is
  // waiting on. The write goes through the pipeline's own pool, so that is
  // where the cancel is slipped in.
  const realQuery = pool.query;
  const intercept = (async (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('INSERT INTO affiliate_links')) {
      await cancelArticle(row.id);
    }
    return (realQuery as (...a: unknown[]) => Promise<unknown>).apply(pool, args);
  }) as typeof pool.query;
  pool.query = intercept;
  try {
    await assert.rejects(runPublisher(row), /lease lost/);
  } finally {
    pool.query = realQuery;
  }

  assert.equal(
    (await livePosts(row.slug!)).length,
    0,
    'the push itself is re-checked against the claim, not just the start of the stage',
  );
  assert.equal(dispatches.count, 0);
});

// ── Delete and restore ─────────────────────────────────────────────────────

test('a deleted post rebuilds the site when it is published again', { skip }, async () => {
  const app = createApp();
  const link = productSlug();
  const row = await article([resolvedLink(link)]);
  const first = captureDispatches();
  await runPublisher(row);
  assert.equal(first.count, 1);

  // The operator's recovery path: remove the post, then publish it again. The
  // dispatch gate is a digest of what was last pushed live, so deleting the
  // post it describes has to clear it - otherwise the re-publish computes the
  // same digest, skips the rebuild, and the page stays missing from the site.
  captureDispatches();
  const removed = await app.fetch(
    new Request(`http://localhost/api/published/${row.slug}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-admin-token', 'X-Platform': 'sleekdrops' },
    }),
  );
  assert.equal(removed.status, 200);
  assert.equal((await livePosts(row.slug!)).length, 0, 'the post is gone from the site');
  // Its pipeline-authored link went with it: no remaining post links to it.
  assert.deepEqual((await removed.json()).removedLinks, [link]);
  assert.equal((await reload(row.id)).published_digest, null);

  const restored = captureDispatches();
  assert.equal((await runPublisher(await reload(row.id))).dispatched, true);
  assert.equal(restored.count, 1);
  assert.equal((await livePosts(row.slug!)).length, 1);
  // The date the piece was first published survives the round trip: restoring
  // a post is not publishing it on a new day.
  assert.equal(await storedPubDate(row.id), '2026-09-14');
});
