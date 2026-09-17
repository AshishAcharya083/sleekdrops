// What a requalification must not break on its way back out to the site.
//
// The rewrite is the easy half. The hard half is that the page has been live
// for months: people have linked to it, its /go/ rows are in the site-wide
// affiliate map, and its publication date is a promise to the reader. So this
// file drives the two deterministic stages that decide all of that - the
// assembler and the publisher - over a real Postgres row, with D1 and the
// Amazon liveness probe stubbed at their network boundaries.
//
// Three things are load-bearing here and none of them is visible in a unit
// test of either stage alone: the original pubDate survives with updatedDate
// stamped beside it, the hero the page already had survives, and a /go/ row
// this pass could not re-verify is left exactly as the live site has it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-d1-token';
process.env.GITHUB_TOKEN = 'test-github-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { getSetting, setSetting } = await import('../db/pool.js');
const { runStage } = await import('../pipeline/runner.js');
const { runAssembler } = await import('./assembler.js');
const { runPublisher } = await import('./publisher.js');
const { requalifyPublished } = await import('../pipeline/requalify.js');

import type { ArticleRow, ContentBrief, RequalificationSource } from '../pipeline/types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/** Fresh per seed: `articles.slug` is unique, and each test seeds its own row. */
const nextSlug = (): string => `requalify-publish-${randomUUID().slice(0, 8)}`;
const PUB_DATE = '2025-06-02';
const TODAY = new Date().toISOString().slice(0, 10);
const HERO = 'https://storage.googleapis.com/images/vacuums.jpg';

const realFetch = globalThis.fetch;
const created: string[] = [];

after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) await q('DELETE FROM articles WHERE id = ANY($1)', [created]);
  await pool.end();
});

/** Every statement the publisher sent to D1, with the params it bound. */
interface D1Call {
  sql: string;
  params: unknown[];
}

/** D1 accepts everything; Amazon confirms the one ASIN this pass re-verifies. */
function stubNetwork(): D1Call[] {
  const calls: D1Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.cloudflare.com')) {
      calls.push(JSON.parse(String(init?.body)) as D1Call);
      return Response.json({ success: true, result: [{ results: [] }] });
    }
    if (url.includes('amazon.com')) return new Response('<html>live listing</html>', { status: 200 });
    // The content-updated repository dispatch.
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return calls;
}

/** The live page a requalification reads, answered at the D1 REST boundary. */
function stubLivePost(slug: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(String(input).includes('api.cloudflare.com'), 'only D1 is stubbed here');
    const { sql } = JSON.parse(String(init?.body)) as D1Call;
    const results = /FROM posts WHERE slug = \?1/.test(sql)
      ? [
          {
            slug,
            status: 'published',
            title: 'Best cordless stick vacuums',
            category: 'Home',
            post_type: 'guide',
            pub_date: PUB_DATE,
            frontmatter_json: JSON.stringify({ title: 'Best cordless stick vacuums', pubDate: PUB_DATE }),
            body_md: draft,
          },
        ]
      : [];
    return Response.json({ success: true, result: [{ results }] });
  }) as typeof fetch;
}

/**
 * Run `body` with publish_mode set, and put the setting back afterwards.
 * publish_mode is one row in a table every test file shares, so every test
 * that depends on it lives in this file and none of them leaves it moved.
 */
async function withPublishMode<T>(mode: string, body: () => Promise<T>): Promise<T> {
  const previous = await getSetting<string>('publish_mode', 'approval');
  await setSetting('publish_mode', mode);
  try {
    return await body();
  } finally {
    await setSetting('publish_mode', previous);
  }
}

const research = {
  summary: 'What actually survives the first year.',
  facts: [],
  products: [
    // Re-researched and found again, but no product URL to probe: the live row
    // is the better destination and this pass has nothing better to offer.
    {
      name: 'Shark Detect Pro',
      brand: 'Shark',
      approxPrice: 'A$1,199',
      amazonUrl: null,
      goSlug: 'shark-detect-pro',
      notes: '',
    },
    // Re-verified against the live marketplace: this one is a revalidation.
    {
      name: 'Dyson V15 Detect',
      brand: 'Dyson',
      approxPrice: 'A$1,449',
      amazonUrl: 'https://www.amazon.com.au/dp/B09TEST123',
      goSlug: 'dyson-v15-detect',
      notes: '',
    },
  ],
  keywords: { primary: 'cordless stick vacuum', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

const briefFor = (slug: string): ContentBrief => ({
  seoTitle: 'Cordless stick vacuums: what survives a year',
  dek: 'What breaks, and how long it takes.',
  slug,
  author: 'home',
  kind: 'Buying guide',
  searchIntent: 'Commercial Investigation',
  primaryKeyword: 'cordless stick vacuum',
  secondaryKeywords: [],
  tags: ['vacuums'],
  wordCountTarget: 1500,
  sections: [],
  faq: [],
});

const draft =
  '## What survives a year\n\nThe [Shark Detect Pro](/go/shark-detect-pro) keeps its brush bar. ' +
  'The [Dyson V15 Detect](/go/dyson-v15-detect) does not.';

const sourceFor = (slug: string): RequalificationSource => ({
  slug,
  title: 'Best cordless stick vacuums',
  angle: 'Suction is not the thing that fails.',
  body: 'The old, templated body linking /go/shark-detect-pro and /go/dyson-v15-detect.',
  pubDate: PUB_DATE,
  goSlugs: ['shark-detect-pro', 'dyson-v15-detect'],
  requestedAt: '2026-09-17T00:00:00.000Z',
});

/** The row as requalifyPublished() leaves it, one pipeline run later. */
async function seedRequalifiedArticle(): Promise<ArticleRow> {
  const slug = nextSlug();
  const brief = briefFor(slug);
  const source = sourceFor(slug);
  const [inserted] = await q<{ id: string }>(
    `INSERT INTO articles
       (title, slug, category, post_type, stage, status, research, outline, draft_md,
        frontmatter, requalification)
     VALUES ($1, $2, 'Home', 'guide', 'assemble', 'running', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      brief.seoTitle,
      slug,
      JSON.stringify(research),
      JSON.stringify(brief),
      draft,
      // What the live page already had, seeded off its D1 frontmatter.
      JSON.stringify({ title: source.title, pubDate: PUB_DATE, heroImage: HERO, heroAlt: 'A stick vacuum' }),
      JSON.stringify(source),
    ],
  );
  created.push(inserted.id);
  const [article] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [inserted.id]);
  return article;
}

test('the rebuilt page keeps its publication date and gains an updated one', { skip }, async () => {
  stubNetwork();
  const article = await seedRequalifiedArticle();
  const assembled = await runAssembler(article);

  assert.equal(assembled.frontmatter.pubDate, PUB_DATE, 'the page was published when it was');
  assert.equal(assembled.frontmatter.updatedDate, TODAY, 'and a reader is told it was revised');
  assert.equal(assembled.frontmatter.lastReviewed, TODAY);
  assert.equal(assembled.frontmatter.heroImage, HERO, 'the image the page already had survives');
  assert.equal(assembled.frontmatter.heroAlt, 'A stick vacuum');
  assert.equal(
    assembled.frontmatter.updateNote,
    'Rewritten from new research. The picks are unchanged: Shark Detect Pro and Dyson V15 Detect.',
    'the fresh date says what earned it, in this page\'s own product names',
  );
});

test('a rebuild that moved nothing leaves the page dated as it was', { skip }, async () => {
  // The freshening failure, driven through the stage that would commit it: a
  // requalification that reproduces the live page must not restamp it, because
  // a date that moves without the content moving is the signal Google's
  // helpful-content guidance names - and the operator can press this button on
  // every page of the site.
  stubNetwork();
  const article = await seedRequalifiedArticle();
  const unchanged = { ...article, draft_md: article.requalification!.body };

  const assembled = await runAssembler(unchanged);

  assert.equal(assembled.frontmatter.pubDate, PUB_DATE);
  assert.equal(assembled.frontmatter.updatedDate, undefined, 'nothing changed, so nothing is claimed');
  assert.equal(assembled.frontmatter.updateNote, undefined);
  assert.equal(assembled.frontmatter.lastReviewed, TODAY, 'it was still checked against its sources');
});

test('an unchanged rebuild keeps the update the page already showed', { skip }, async () => {
  // And it keeps that update's own note with it: the sentence belongs to the
  // revision that earned the date, not to the pass that happened to run last.
  stubNetwork();
  const article = await seedRequalifiedArticle();
  const priorNote = 'Swapped the budget pick after the Kmart model was discontinued.';
  await q(
    `UPDATE articles
        SET frontmatter = frontmatter || jsonb_build_object('updatedDate', $2::text, 'updateNote', $3::text)
      WHERE id = $1`,
    [article.id, '2026-01-05', priorNote],
  );
  const [reloaded] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);

  const assembled = await runAssembler({ ...reloaded, draft_md: reloaded.requalification!.body });

  assert.equal(assembled.frontmatter.updatedDate, '2026-01-05');
  assert.equal(assembled.frontmatter.updateNote, priorNote);
});

test('a page published today still reports the rebuild', { skip }, async () => {
  stubNetwork();
  const article = await seedRequalifiedArticle();
  await q('UPDATE articles SET frontmatter = jsonb_set(frontmatter, \'{pubDate}\', $2::jsonb) WHERE id = $1', [
    article.id,
    JSON.stringify(TODAY),
  ]);
  const [sameDay] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);

  const assembled = await runAssembler(sameDay);
  // Without the requalification marker this branch stamps nothing - pubDate
  // equals today - and the reader could not tell a rebuild from a first run.
  assert.equal(assembled.frontmatter.updatedDate, TODAY);
});

test('an editorial pass after the rebuild landed is not measured against the old page', { skip }, async () => {
  // The marker stays on the row for good - it is what holds the slug on every
  // later run - so once the rebuild is live, the page it replaced is gone and
  // a feedback pass measured against it would describe a change the reader was
  // shown at the rebuild. It is an ordinary edit from here, dated as one.
  stubNetwork();
  const article = await seedRequalifiedArticle();
  await q('UPDATE articles SET published_at = now() WHERE id = $1', [article.id]);
  const [republished] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);

  const assembled = await runAssembler(republished);

  assert.equal(assembled.frontmatter.updatedDate, TODAY, 'an edit of a page published in June is an update');
  assert.equal(
    assembled.frontmatter.updateNote,
    undefined,
    'and it has nothing to say about what changed, so it says nothing',
  );
});

test('a /go/ row this pass cannot re-verify is left as the live site has it', { skip }, async () => {
  stubNetwork();
  const article = await seedRequalifiedArticle();
  const assembled = await runAssembler(article);

  const links = new Map(assembled.affiliateLinks.map((link) => [link.slug, link]));
  assert.equal(links.size, 2, 'both live destinations survived into the rebuilt body');
  assert.equal(
    links.get('shark-detect-pro')?.preserved,
    true,
    'no verified ASIN this time, and the live row may carry one',
  );
  assert.equal(
    links.get('dyson-v15-detect')?.preserved,
    undefined,
    'a re-verified ASIN is a revalidation, and revalidation overwrites',
  );
  assert.deepEqual(links.get('dyson-v15-detect')?.regions_json?.asins, { au: 'B09TEST123' });
});

test('the publisher yields on a preserved row and refreshes a revalidated one', { skip }, async () => {
  const calls = stubNetwork();
  const article = await seedRequalifiedArticle();
  const assembled = await runAssembler(article);

  await q('UPDATE articles SET draft_md = $2, frontmatter = $3, affiliate_links = $4 WHERE id = $1', [
    article.id,
    assembled.body,
    JSON.stringify(assembled.frontmatter),
    JSON.stringify(assembled.affiliateLinks),
  ]);
  const [ready] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);

  calls.length = 0;
  const result = await runPublisher(ready);
  assert.equal(result.slug, article.slug, 'the rebuild lands on the page it came from');

  const affiliate = calls.filter((call) => call.sql.includes('INSERT INTO affiliate_links'));
  const statementFor = (slug: string): string => {
    const call = affiliate.find((c) => c.params[0] === slug);
    assert.ok(call, `no affiliate statement for ${slug}`);
    return call.sql;
  };
  assert.match(
    statementFor('shark-detect-pro'),
    /ON CONFLICT \(slug\) DO NOTHING/,
    'overwriting it could send readers of a live page to a search results page',
  );
  assert.match(statementFor('dyson-v15-detect'), /ON CONFLICT \(slug\) DO UPDATE SET/);

  const [posts] = calls.filter((call) => call.sql.includes('INSERT INTO posts'));
  assert.ok(posts, 'the page itself is upserted');
  assert.equal(posts.params[0], article.slug, 'at the same slug, so nothing that links here 404s');
  assert.equal(posts.params[6], PUB_DATE, 'and with the date it was first published');
  const frontmatter = JSON.parse(String(posts.params[7])) as Record<string, unknown>;
  assert.equal(frontmatter.updatedDate, TODAY);
  assert.match(String(frontmatter.updateNote), /^Rewritten from new research\./);
  assert.equal(frontmatter.heroImage, HERO);
});

test('a requalification still stops at the approval gate', { skip }, async () => {
  stubNetwork();
  const article = await seedRequalifiedArticle();
  // The image stage is the gate: it is the last thing before publish, and it
  // reads publish_mode. An operator hero means it runs without a model.
  await q(
    `UPDATE articles SET stage = 'image', status = 'running',
        hero_image_url = $2, frontmatter = jsonb_set(frontmatter, '{heroImage}', $3::jsonb)
      WHERE id = $1`,
    [article.id, HERO, JSON.stringify(HERO)],
  );
  const atImage = async () => (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]))[0];

  await withPublishMode('approval', async () => {
    await runStage(await atImage());
    const row = await atImage();
    assert.equal(row.stage, 'publish');
    assert.equal(
      row.status,
      'waiting_approval',
      'a rebuild of a live page must not go out without the same review a new one gets',
    );
  });

  // And the operator who turned the gate off still gets what they asked for.
  await q("UPDATE articles SET stage = 'image', status = 'running' WHERE id = $1", [article.id]);
  await withPublishMode('auto', async () => {
    await runStage(await atImage());
    const row = await atImage();
    assert.equal(row.stage, 'publish');
    assert.equal(row.status, 'queued');
  });
});

test('a requalification that would unpublish the live page is refused', { skip }, async () => {
  // Draft mode parks whatever finishes in D1 unpublished, and the site build
  // only selects published rows - so on a page that is already live it is a
  // deletion with no approval checkpoint in front of it. The refusal happens
  // before the run costs anything.
  const slug = nextSlug();
  stubLivePost(slug);

  const refused = await withPublishMode('draft', () => requalifyPublished(slug));
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.status, 409);
  assert.match(
    refused.ok === false ? refused.error : '',
    /publish mode is "draft"/,
    'and it says which setting to change',
  );
  const [orphan] = await q('SELECT id FROM articles WHERE slug = $1', [slug]);
  assert.equal(orphan, undefined, 'nothing was queued against the live page');

  // The same page, in a mode it can survive: approval still gates the rebuild.
  const queued = await withPublishMode('approval', () => requalifyPublished(slug));
  assert.equal(queued.ok, true, queued.ok === false ? queued.error : '');
  if (queued.ok) created.push(queued.articleId);
});

test('the publisher will not unpublish a live page when the mode flips mid-run', { skip }, async () => {
  const calls = stubNetwork();
  const article = await seedRequalifiedArticle();

  calls.length = 0;
  await withPublishMode('draft', async () => {
    await assert.rejects(
      () => runPublisher(article),
      /publish mode is "draft"/,
      'the stage fails rather than replacing the live row with an unpublished one',
    );
    assert.equal(
      calls.filter((call) => call.sql.includes('INSERT INTO posts')).length,
      0,
      'the live page is left exactly as it is',
    );

    // The mode still does what it is for on an article that is not a rebuild.
    const fresh = await runPublisher({ ...article, requalification: null });
    assert.equal(fresh.d1Status, 'draft');
    assert.equal(fresh.dispatched, false);
  });
});
