// A launch-window card, driven the way the panel drives it: a real Postgres
// row, the offer attached through the admin API with the verb, header and body
// the panel actually sends, then the assemble stage run over the result.
//
// This is the path the feature exists for. The product was announced this
// morning, so it is in no affiliate feed and cannot be read through Amazon's
// Product Advertising API - the only destination and the only price it can
// have are the ones an editor types, and what this test holds is that they
// reach the affiliate row and the frontmatter stamp intact, that a feed taking
// the record over later does not erase them, and that the contract check lets
// a human-chosen destination outside the Amazon marketplaces through.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { runStage } = await import('./runner.js');
const { saveOffer } = await import('../db/offers.js');

import type { AffiliateLinkRow, ArticleRow, ContentBrief } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const TODAY = new Date().toISOString().slice(0, 10);

/** The dossier of a phone announced this morning: named, and unpollable. */
const research = {
  summary: 'Google announced the Pixel 11 Pro this morning; nothing is shipping until October.',
  facts: [],
  products: [
    {
      name: 'Google Pixel 11 Pro',
      brand: 'Google',
      approxPrice: 'about A$1,699',
      amazonUrl: null,
      goSlug: 'pixel-11-pro',
      notes: 'announced today, no listing anywhere yet',
    },
  ],
  keywords: { primary: 'google pixel 11 pro', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

const keywordPlan = {
  intent: 'Commercial Investigation',
  primaryKeyword: 'google pixel 11 pro australia',
  difficulty: 'Moderate',
  zeroClickRisk: 'Medium',
  wordCountTarget: 1400,
  contentGaps: [],
  entities: ['Google'],
};

const draft =
  '## The one to pre-order\n\n' +
  'The [Google Pixel 11 Pro](/go/pixel-11-pro) is the only one of the three worth the money.';

function brief(): ContentBrief {
  return {
    seoTitle: 'Should you pre-order the Pixel 11 Pro?',
    dek: 'What it costs, and when you are actually charged.',
    slug: `pixel-11-pro-preorder-${randomUUID().slice(0, 8)}`,
    author: 'desk',
    kind: 'Buying guide',
    searchIntent: 'Commercial Investigation',
    primaryKeyword: 'google pixel 11 pro australia',
    secondaryKeywords: [],
    tags: ['phones'],
    wordCountTarget: 1400,
    sections: [],
    faq: [],
  };
}

async function insertAtAssemble(): Promise<ArticleRow> {
  const [row] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, claimed_by, claimed_at,
                           research, keyword_plan, outline, draft_md)
     VALUES ($1, 'Tech', 'guide', 'assemble', 'running', 'test-worker', now(), $2, $3, $4, $5)
     RETURNING *`,
    [
      'Should you pre-order the Pixel 11 Pro?',
      JSON.stringify(research),
      JSON.stringify(keywordPlan),
      JSON.stringify(brief()),
      draft,
    ],
  );
  return row;
}

async function reload(id: string): Promise<ArticleRow> {
  return (await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [id]))[0];
}

const preorderBody = {
  productName: 'Google Pixel 11 Pro',
  url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro-256gb',
  price: '1699',
  currency: 'AUD',
  priceObservedOn: TODAY,
  preorder: true,
  releaseDate: '2099-10-02',
  merchant: 'JB Hi-Fi',
};

async function attach(articleId: string, body: Record<string, unknown> = preorderBody) {
  return app.fetch(
    new Request(`http://localhost/api/articles/${articleId}/offers/pixel-11-pro`, {
      method: 'PUT',
      headers: AUTH,
      body: JSON.stringify(body),
    }),
  );
}

after(async () => {
  if (reachable) await pool.end();
});

test('the panel attaches an offer and reads its own coverage back', { skip }, async () => {
  const article = await insertAtAssemble();

  const empty = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers`, { headers: AUTH }),
  );
  assert.equal(empty.status, 200);
  const before = (await empty.json()) as {
    coverage: { rows: Array<{ provenance: string; goSlug: string }>; covered: number };
  };
  assert.deepEqual(
    before.coverage.rows.map((row) => [row.goSlug, row.provenance]),
    [['pixel-11-pro', 'none']],
    'a product announced today has nothing behind it until somebody attaches one',
  );
  assert.equal(before.coverage.covered, 0);

  const saved = await attach(article.id);
  assert.equal(saved.status, 200);
  const after = (await saved.json()) as {
    coverage: {
      rows: Array<{ provenance: string; price: string | null; preorder: boolean; stale: boolean }>;
      covered: number;
    };
    history: Record<string, unknown[]>;
  };
  assert.equal(after.coverage.covered, 1);
  assert.equal(after.coverage.rows[0].provenance, 'editor');
  assert.equal(after.coverage.rows[0].price, 'A$1,699');
  assert.equal(after.coverage.rows[0].preorder, true);
  assert.equal(after.coverage.rows[0].stale, true, 'nobody is polling a price a person typed');
  assert.equal(after.history['pixel-11-pro'].length, 1);
});

test('a save the reader would be misled by is refused', { skip }, async () => {
  const article = await insertAtAssemble();

  const undated = await attach(article.id, { ...preorderBody, priceObservedOn: null });
  assert.equal(undated.status, 400);
  assert.match(((await undated.json()) as { error: string }).error, /date it was observed/);

  const tagged = await attach(article.id, {
    ...preorderBody,
    url: 'https://www.amazon.com.au/dp/B0FQ1234XY?tag=sleekdrops-22',
  });
  assert.equal(tagged.status, 400);
  assert.match(((await tagged.json()) as { error: string }).error, /tag=/);

  const noRelease = await attach(article.id, { ...preorderBody, releaseDate: null });
  assert.equal(noRelease.status, 400);
  assert.match(((await noRelease.json()) as { error: string }).error, /release date/);

  const [count] = await q<{ n: string }>(
    'SELECT count(*) n FROM product_offers WHERE article_id = $1',
    [article.id],
  );
  assert.equal(count.n, '0', 'nothing was written by any of the refused saves');
});

test('the attached offer becomes the destination and the price stamp', { skip }, async () => {
  const article = await insertAtAssemble();
  assert.equal((await attach(article.id)).status, 200);

  await runStage(await reload(article.id));
  const assembled = await reload(article.id);

  assert.equal(assembled.status, 'queued', assembled.error ?? '');
  assert.equal(assembled.stage, 'image', 'the card moves on');

  const links = (assembled.affiliate_links ?? []) as AffiliateLinkRow[];
  assert.equal(links.length, 1);
  assert.equal(links[0].slug, 'pixel-11-pro');
  assert.equal(links[0].default_url, preorderBody.url, 'the editor’s destination, not a search link');
  assert.equal(links[0].manual, true);
  assert.equal(links[0].regions_json, null);
  assert.match(links[0].note!, /editor-attached offer, A\$1,699 as at/);

  const picks = (assembled.frontmatter?.picks ?? []) as Array<{
    name: string;
    price?: string;
    offer?: Record<string, unknown>;
  }>;
  assert.equal(picks.length, 1);
  assert.equal(picks[0].price, 'A$1,699', 'the dated figure beats the dossier’s approximation');
  assert.deepEqual(picks[0].offer, {
    price: 'A$1,699',
    currency: 'AUD',
    asAt: TODAY,
    source: 'editor',
    stale: true,
    merchant: 'JB Hi-Fi',
    preorder: true,
    releaseDate: '2099-10-02',
  });

  const [session] = await q<{ status: string; summary: string }>(
    `SELECT status, summary FROM agent_sessions WHERE article_id = $1 AND agent = 'assembler'`,
    [article.id],
  );
  assert.equal(session.status, 'done');
  assert.match(session.summary, /1 from attached offer\(s\): pixel-11-pro/);
});

test('a feed taking the record over does not erase the launch-day entry', { skip }, async () => {
  const article = await insertAtAssemble();
  assert.equal((await attach(article.id)).status, 200);

  // What a feed sync does once the merchant finally publishes the SKU.
  await saveOffer(article.id, {
    goSlug: 'pixel-11-pro',
    productName: 'Google Pixel 11 Pro',
    url: 'https://www.jbhifi.com.au/products/google-pixel-11-pro-256gb?utm=feed',
    price: '1599.00',
    currency: 'AUD',
    priceObservedOn: TODAY,
    preorder: false,
    releaseDate: null,
    merchant: 'JB Hi-Fi',
    source: 'feed',
    enteredBy: 'feed',
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers`, { headers: AUTH }),
  );
  const seen = (await res.json()) as {
    coverage: { rows: Array<{ provenance: string; price: string | null; stale: boolean }> };
    history: Record<string, Array<{ source: string; price: string | null; entered_by: string }>>;
  };
  assert.equal(seen.coverage.rows[0].provenance, 'resolved', 'the feed’s figure is current');
  assert.equal(seen.coverage.rows[0].price, 'A$1,599');
  assert.equal(seen.coverage.rows[0].stale, false);

  const history = seen.history['pixel-11-pro'];
  assert.equal(history.length, 2, 'both versions are kept');
  assert.equal(history[0].source, 'feed');
  assert.equal(history[1].source, 'editor');
  assert.equal(history[1].price, '1699.00', 'the price the page quoted on launch day is still readable');
  assert.equal(history[1].entered_by, 'operator');

  // One record per product, not one per source.
  const [current] = await q<{ n: string }>(
    'SELECT count(*) n FROM product_offers WHERE article_id = $1',
    [article.id],
  );
  assert.equal(current.n, '1');
});

test('detaching keeps the history and hands the product back to the fallback', { skip }, async () => {
  const article = await insertAtAssemble();
  assert.equal((await attach(article.id)).status, 200);

  const removed = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers/pixel-11-pro`, {
      method: 'DELETE',
      headers: AUTH,
    }),
  );
  assert.equal(removed.status, 200);
  const after = (await removed.json()) as {
    coverage: { rows: Array<{ provenance: string }>; covered: number };
    history: Record<string, unknown[]>;
  };
  assert.equal(after.coverage.rows[0].provenance, 'none');
  assert.equal(after.coverage.covered, 0);
  assert.equal(after.history['pixel-11-pro'].length, 1, 'what a reader was shown outlives the record');

  const again = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers/pixel-11-pro`, {
      method: 'DELETE',
      headers: AUTH,
    }),
  );
  assert.equal(again.status, 404);
});

test('detaching after assembly leaves the page flagged for a rebuild', { skip }, async () => {
  // The order that actually bites: attach, build, then change your mind. The
  // reader is still being sent to the detached destination and shown its price
  // until the card is rebuilt, so the panel has to say so - and has to leave
  // the rebuild reachable with no offer left on the card at all.
  const article = await insertAtAssemble();
  assert.equal((await attach(article.id)).status, 200);
  await runStage(await reload(article.id));
  const built = await reload(article.id);
  assert.equal((built.affiliate_links ?? [])[0].default_url, preorderBody.url);

  const removed = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers/pixel-11-pro`, {
      method: 'DELETE',
      headers: AUTH,
    }),
  );
  assert.equal(removed.status, 200);
  const after = (await removed.json()) as {
    coverage: {
      rows: Array<{
        provenance: string;
        label: string;
        destination: string | null;
        destinationNote: string | null;
        price: string | null;
        pending: boolean;
      }>;
      covered: number;
    };
  };
  const row = after.coverage.rows[0];
  assert.equal(row.provenance, 'none', 'nothing is attached to it any more');
  assert.equal(row.destination, preorderBody.url, 'still where the built page sends a reader');
  assert.equal(row.label, 'Detached offer');
  assert.doesNotMatch(row.destinationNote!, /search/, 'the note has to match that URL');
  assert.equal(row.price, null);
  assert.equal(row.pending, true, 'the rebuild prompt is the whole point');
  assert.equal(after.coverage.covered, 0);

  const requeued = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/reassemble`, {
      method: 'POST',
      headers: AUTH,
    }),
  );
  assert.equal(requeued.status, 200);
  await runStage(await q<ArticleRow>(
    `UPDATE articles SET status = 'running', claimed_by = 'test-worker', claimed_at = now()
      WHERE id = $1 RETURNING *`,
    [article.id],
  ).then((rows) => rows[0]));

  const rebuilt = await reload(article.id);
  assert.equal(rebuilt.status, 'queued', rebuilt.error ?? '');
  assert.match((rebuilt.affiliate_links ?? [])[0].default_url, /amazon\.com\.au\/s\?k=/);
  const picks = (rebuilt.frontmatter?.picks ?? []) as Array<{ offer?: unknown }>;
  assert.equal(picks[0].offer, undefined, 'the detached price is off the page');

  const final = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers`, { headers: AUTH }),
  );
  const done = (await final.json()) as {
    coverage: { rows: Array<{ provenance: string; label: string; pending: boolean }> };
  };
  assert.equal(done.coverage.rows[0].pending, false, 'nothing left to rebuild');
  assert.equal(done.coverage.rows[0].label, 'Search link');
});

test('a card still in review cannot be pulled forward to assemble', { skip }, async () => {
  // The rebuild is for a page that already exists. Sending a piece that has
  // not been reviewed yet straight to assemble would skip the stages it has
  // not had, and a card that has never assembled picks the offers up on its
  // first pass anyway.
  const [inReview] = await q<ArticleRow>(
    `INSERT INTO articles (title, category, post_type, stage, status, research, keyword_plan,
                           outline, draft_md)
     VALUES ($1, 'Tech', 'guide', 'seo_review', 'queued', $2, $3, $4, $5)
     RETURNING *`,
    [
      'Should you pre-order the Pixel 11 Pro?',
      JSON.stringify(research),
      JSON.stringify(keywordPlan),
      JSON.stringify(brief()),
      draft,
    ],
  );

  const refused = await app.fetch(
    new Request(`http://localhost/api/articles/${inReview.id}/reassemble`, {
      method: 'POST',
      headers: AUTH,
    }),
  );
  assert.equal(refused.status, 409);
  const still = await reload(inReview.id);
  assert.equal(still.stage, 'seo_review');
  assert.equal(still.status, 'queued');
});

test('an offer attached after assembly is flagged, and the rebuild carries it', { skip }, async () => {
  const article = await insertAtAssemble();

  // Assembled first: the body's only /go/ link heals to a search, because
  // nothing else exists for a SKU announced this morning.
  await runStage(await reload(article.id));
  const healed = await reload(article.id);
  assert.match((healed.affiliate_links ?? [])[0].default_url, /amazon\.com\.au\/s\?k=/);

  assert.equal((await attach(article.id)).status, 200);
  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers`, { headers: AUTH }),
  );
  const seen = (await res.json()) as { coverage: { rows: Array<{ pending: boolean }> } };
  assert.equal(seen.coverage.rows[0].pending, true, 'saved, but the built page still has the search link');

  const requeued = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/reassemble`, {
      method: 'POST',
      headers: AUTH,
    }),
  );
  assert.equal(requeued.status, 200);
  const queued = await reload(article.id);
  assert.equal(queued.stage, 'assemble');
  assert.equal(queued.status, 'queued');

  await runStage(await q<ArticleRow>(
    `UPDATE articles SET status = 'running', claimed_by = 'test-worker', claimed_at = now()
      WHERE id = $1 RETURNING *`,
    [article.id],
  ).then((rows) => rows[0]));

  const rebuilt = await reload(article.id);
  assert.equal(rebuilt.status, 'queued', rebuilt.error ?? '');
  assert.equal((rebuilt.affiliate_links ?? [])[0].default_url, preorderBody.url);

  const final = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/offers`, { headers: AUTH }),
  );
  const done = (await final.json()) as { coverage: { rows: Array<{ pending: boolean }> } };
  assert.equal(done.coverage.rows[0].pending, false);
});
