// Requalification where it actually bites: the admin API the panel drives with
// its own verbs, real Postgres rows behind it, and the live page stubbed at
// the D1 REST boundary.
//
// The contract this file defends is narrow and load-bearing. A published page
// goes back to research and comes out at the SAME address: if the slug moves,
// the page 404s for everyone who ever linked to it and the affiliate rows
// noted against it are orphaned. Nothing about that is provable in memory -
// the slug guard is a SQL update, the refusal is an HTTP response, and the
// article row it writes is what the worker picks up next. Point DATABASE_URL
// at a throwaway server to run these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { resolveArticleSlug } = await import('./runner.js');
const { createApp } = await import('../api/server.js');
const { holdPublishMode } = await import('../testing/publishMode.js');

import type { ArticleRow, RequalificationSource } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

// Every requalification below expects to be served, and the one mode that
// refuses one - 'draft' - is set for a window by requalifyPublish.db.test.ts,
// in another process against this same database. Hold the mode as configured
// for as long as this file runs so that window cannot open underneath it.
const releasePublishMode = reachable ? await holdPublishMode() : null;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

const SLUG = 'requalify-test-beef-tallow-skincare';
const BODY = [
  '## Is beef tallow good for skin?',
  '',
  'The [Fatco balm](/go/fatco-tallow-balm) is the one most people should buy.',
  'The [Vintage Tradition balm](/go/vintage-tradition-tallow) is the cheaper pick.',
].join('\n');

const LIVE_POST = {
  slug: SLUG,
  status: 'published',
  title: 'Beef tallow skincare: does it work?',
  category: 'Health',
  post_type: 'guide',
  pub_date: '2026-02-11',
  frontmatter_json: JSON.stringify({
    title: 'Beef tallow skincare: does it work?',
    dek: 'Rendered fat, on your face.',
    pubDate: '2026-02-11',
    heroImage: 'https://storage.googleapis.com/images/tallow.jpg',
    heroAlt: 'A jar of tallow balm',
    author: 'desk',
  }),
  body_md: BODY,
};

const realFetch = globalThis.fetch;

/** Answer the one D1 read a requalification makes; refuse anything else loudly. */
function stubD1(post: typeof LIVE_POST | null): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(String(input).includes('api.cloudflare.com'), 'only D1 is stubbed here');
    const { sql } = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
    assert.match(sql, /FROM posts WHERE slug = \?1/, `unexpected D1 statement: ${sql}`);
    return Response.json({ success: true, result: [{ results: post ? [post] : [] }] });
  }) as typeof fetch;
}

const created: string[] = [];

after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) {
    await q('DELETE FROM agent_sessions WHERE article_id = ANY($1)', [created]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
    await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  }
  await releasePublishMode?.();
  await pool.end();
});

interface RequalifyBody {
  ok?: boolean;
  article_id?: string;
  created?: boolean;
  go_slugs?: string[];
  error?: string;
}

const postRequalify = async (path: string): Promise<{ status: number; body: RequalifyBody }> => {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method: 'POST', headers: AUTH }),
  );
  return { status: res.status, body: (await res.json()) as RequalifyBody };
};

const articleRow = async (id: string): Promise<ArticleRow> => {
  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]);
  return row;
};

/** A published page with no pipeline article behind it - most of the site. */
async function requalifyFreshPage(): Promise<string> {
  await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  stubD1(LIVE_POST);
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 200, body.error);
  const id = String(body.article_id);
  created.push(id);
  return id;
}

test('a live page with no article behind it gets one, queued at research', { skip }, async () => {
  const id = await requalifyFreshPage();
  const article = await articleRow(id);

  assert.equal(article.stage, 'research');
  assert.equal(article.status, 'queued');
  assert.equal(article.slug, SLUG, 'the rebuild is of this page, so it starts at its address');
  assert.equal(article.category, 'Health');
  assert.equal(article.post_type, 'guide');

  const source = article.requalification as RequalificationSource;
  assert.equal(source.slug, SLUG);
  assert.equal(source.body, BODY, 'the researcher is told what is already published');
  assert.equal(source.angle, 'Rendered fat, on your face.', 'the dek is what the page promised');
  assert.equal(source.pubDate, '2026-02-11');
  assert.deepEqual(
    source.goSlugs,
    ['fatco-tallow-balm', 'vintage-tradition-tallow'],
    'the live /go/ destinations are captured so the rebuild cannot break them',
  );

  // The publication date and the hero the page already has are seeded onto the
  // article: the assembler reads both off here, and losing either would
  // republish a years-old page as brand new, without its image.
  assert.equal(article.frontmatter?.pubDate, '2026-02-11');
  assert.equal(article.frontmatter?.heroImage, 'https://storage.googleapis.com/images/tallow.jpg');
});

test('the outline stage cannot move a requalified slug', { skip }, async () => {
  const id = await requalifyFreshPage();
  const article = await articleRow(id);

  assert.equal(
    await resolveArticleSlug(article, 'best-beef-tallow-skincare-2026'),
    SLUG,
    'the outliner proposed a better slug and does not get it',
  );
  // The same article without the marker takes the outliner's proposal, which
  // is what makes the lock a decision rather than an accident of uniqueness.
  assert.equal(
    await resolveArticleSlug({ ...article, requalification: null }, 'best-beef-tallow-skincare-2026'),
    'best-beef-tallow-skincare-2026',
  );
});

test('requalifying an article that already exists rebuilds it in place', { skip }, async () => {
  const first = await requalifyFreshPage();
  // Walk it to a finished state, the way a real run would leave it.
  await q(
    `UPDATE articles
        SET stage = 'done', status = 'done', revision_round = 2,
            research = '{"summary":"old"}'::jsonb, draft_md = 'old draft',
            outline = '{"slug":"x"}'::jsonb, seo_review = '{"score":55}'::jsonb,
            keyword_plan = '{"primaryKeyword":"old"}'::jsonb,
            editorial_angle = '{"thesis":"tallow is fine","shape":"ranked-list"}'::jsonb,
            published_at = now()
      WHERE id = $1`,
    [first],
  );

  stubD1(LIVE_POST);
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 200, body.error);
  assert.equal(body.article_id, first, 'one slug, one article row - never a second');
  assert.equal(body.created, false);

  const article = await articleRow(first);
  assert.equal(article.stage, 'research');
  assert.equal(article.status, 'queued');
  assert.equal(article.revision_round, 0);
  // Everything the old run derived is exactly what must not survive: a dossier
  // and a draft written under the prompts that produced the flagged page.
  assert.equal(article.research, null);
  assert.equal(article.draft_md, null);
  assert.equal(article.outline, null);
  assert.equal(article.seo_review, null);
  assert.equal(article.keyword_plan, null);
  assert.equal(article.editorial_angle, null);
  // ... but the recorded thesis is the sharpest statement of what the page
  // argued, so it is carried into the rebuild as input before it is cleared.
  assert.equal(article.requalification?.angle, 'tallow is fine');
  assert.equal(article.frontmatter?.pubDate, '2026-02-11', 'the page keeps its publication date');
});

test('the article view reaches the same requalification by id', { skip }, async () => {
  const id = await requalifyFreshPage();
  await q("UPDATE articles SET stage = 'done', status = 'done' WHERE id = $1", [id]);

  stubD1(LIVE_POST);
  const { status, body } = await postRequalify(`/api/articles/${id}/requalify`);
  assert.equal(status, 200, body.error);
  assert.equal(body.article_id, id);
  assert.equal((await articleRow(id)).stage, 'research');
});

test('an article with no slug has no live page to requalify', { skip }, async () => {
  const [draft] = await q<{ id: string }>(
    `INSERT INTO articles (title, category, post_type) VALUES ('Unpublished', 'Tech', 'article')
     RETURNING id`,
  );
  created.push(draft.id);

  const { status, body } = await postRequalify(`/api/articles/${draft.id}/requalify`);
  assert.equal(status, 409);
  assert.match(String(body.error), /no slug yet/);
});

test('a slug the site does not have is a 404, not a new article', { skip }, async () => {
  stubD1(null);
  const { status, body } = await postRequalify('/api/published/not-a-real-page/requalify');
  assert.equal(status, 404);
  assert.equal(body.error, 'no live post with that slug');
  const [orphan] = await q('SELECT id FROM articles WHERE slug = $1', ['not-a-real-page']);
  assert.equal(orphan, undefined, 'a missing page must not leave an article row behind');
});

test('a page whose article is mid-pipeline is refused, not reset underneath it', { skip }, async () => {
  const id = await requalifyFreshPage();
  await q("UPDATE articles SET stage = 'write', status = 'running' WHERE id = $1", [id]);

  stubD1(LIVE_POST);
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 409);
  assert.match(String(body.error), /already in the pipeline at write\/running/);

  const article = await articleRow(id);
  assert.equal(article.stage, 'write', 'the running stage is left exactly where it was');
  assert.equal(article.status, 'running');
});

test('a live page with an empty body has nothing to requalify from', { skip }, async () => {
  await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  stubD1({ ...LIVE_POST, body_md: '   ' });
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 409);
  assert.match(String(body.error), /carries no body/);
});

test('a page the pipeline could not publish is refused before it costs a run', { skip }, async () => {
  await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  // The old site published `review` posts; this pipeline never does, and the
  // site's frontmatter schema would reject one at assembly - after research,
  // angle, outline, write and up to two review rounds on Opus 5.
  stubD1({ ...LIVE_POST, post_type: 'review' });
  const bad = await postRequalify(`/api/published/${encodeURIComponent(SLUG)}/requalify`);
  assert.equal(bad.status, 409);
  assert.match(String(bad.body.error), /filed as post_type "review"/);
  assert.match(String(bad.body.error), /article, guide, roundup/, 'the refusal says what it must be');

  stubD1({ ...LIVE_POST, category: 'Gardening' });
  const worse = await postRequalify(`/api/published/${encodeURIComponent(SLUG)}/requalify`);
  assert.equal(worse.status, 409);
  assert.match(String(worse.body.error), /filed as category "Gardening"/);

  const [orphan] = await q('SELECT id FROM articles WHERE slug = $1', [SLUG]);
  assert.equal(orphan, undefined, 'and nothing was queued');
});

test('a legacy timestamp is reduced to the date the site schema takes', { skip }, async () => {
  await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  // A row imported from the old content collection can carry a full timestamp.
  // Left alone it fails frontmatter validation at assembly, at the end of a
  // full pipeline run.
  stubD1({
    ...LIVE_POST,
    pub_date: '2026-02-11T00:00:00.000Z',
    frontmatter_json: JSON.stringify({ title: LIVE_POST.title, dek: 'A dek.' }),
  });
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 200, body.error);
  created.push(String(body.article_id));

  const article = await articleRow(String(body.article_id));
  assert.equal(article.frontmatter?.pubDate, '2026-02-11');
  assert.equal(article.requalification?.pubDate, '2026-02-11');
});

test('a page with no usable date is dated today rather than failing assembly', { skip }, async () => {
  await q('DELETE FROM articles WHERE slug = $1', [SLUG]);
  stubD1({
    ...LIVE_POST,
    pub_date: null as unknown as string,
    frontmatter_json: JSON.stringify({ title: LIVE_POST.title, pubDate: 'sometime in 2024' }),
  });
  const { status, body } = await postRequalify(
    `/api/published/${encodeURIComponent(SLUG)}/requalify`,
  );
  assert.equal(status, 200, body.error);
  created.push(String(body.article_id));

  const article = await articleRow(String(body.article_id));
  assert.equal(article.frontmatter?.pubDate, undefined, 'the unusable value is dropped, not carried');
  assert.equal(article.requalification?.pubDate, null);
});

test('requalification needs the same admin token every other route does', { skip }, async () => {
  const res = await app.fetch(
    new Request(`http://localhost/api/published/${SLUG}/requalify`, { method: 'POST' }),
  );
  assert.equal(res.status, 401);
});
