// The restructured review where it actually lands: a real JSONB column, the
// admin API the operator panel reads it back through, and the two consumers
// that work off the row rather than off the object the reviewer returned.
//
// seoReviewer.test.ts proves the merge and the hard fails deterministically.
// It cannot prove that the new dimensions, the competitor delta and the claim
// audit survive the round trip, that a review written before the restructure
// still renders its own axes instead of five "undefined"s, or that the editor
// picks the right issues off a row it read out of the database. Those only
// happen against Postgres. Point DATABASE_URL at a throwaway server to run
// these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { summariseReview } = await import('./runner.js');
const { issuesForEditor } = await import('../agents/editor.js');
const { ISSUE_PREFIX } = await import('../agents/seoReviewer.js');

import type { ArticleRow, SeoReview } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };

after(async () => {
  if (reachable) await pool.end();
});

async function insertArticle(fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const row = {
    title: `Best cordless stick vacuums ${randomUUID().slice(0, 8)}`,
    category: 'Home',
    post_type: 'guide',
    ...fields,
  };
  const keys = Object.keys(row);
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return inserted;
}

function review(): SeoReview {
  return {
    score: 54,
    pass: false,
    summary: 'Competent and generic. It restates the top results with better sentences.',
    dimensions: { evidence: 55, position: 40, structure: 54, citability: 71, links: 88 },
    slop: { score: 92, words: 1840, findings: 2 },
    issues: [
      { severity: 'low', issue: 'The dek runs to 168 characters.', fix: 'Cut it to 160.' },
      {
        severity: 'high',
        issue: `${ISSUE_PREFIX.claim}[price] "A$229 at Amazon" - no dossier entry carries this price`,
        fix: 'Cut it, or restate it in plain words the dossier does carry.',
      },
      {
        severity: 'high',
        issue: `${ISSUE_PREFIX.delta}this draft adds nothing the top 3 result(s) do not already carry.`,
        fix: 'Land a failure mode with a timeframe.',
      },
      { severity: 'medium', issue: 'No comparison table.', fix: 'Add one.' },
      { severity: 'high', issue: `${ISSUE_PREFIX.scan}AI vocabulary: "delve" x2 (line 14)`, fix: 'Rewrite the sentence.' },
      // Reviews written before the prefix was normalised carry an em dash.
      { severity: 'high', issue: 'Voice scan — Hedge adverbs x6', fix: 'Delete them.' },
    ],
    competitorDelta: {
      comparedWith: ['https://a.example/best', 'https://b.example/best', 'https://c.example/best'],
      additions: [],
      duplicated: ['the same five picks in the same order'],
      verdict: 'adds-nothing',
      notes: 'Nothing here that the three ranking pages do not already say.',
    },
    claimAudit: { checked: 18, unsupported: 3 },
    positionCheck: {
      takesStance: false,
      stance: '',
      recommendsEverythingEqually: true,
      picks: [{ pick: 'Dyson V15', cons: [], hedged: false }],
      notes: 'Every entry wins at something.',
    },
  };
}

test('the restructured review survives JSONB and reaches the panel whole', { skip }, async () => {
  const article = await insertArticle({
    stage: 'seo_review',
    status: 'queued',
    seo_review: JSON.stringify(review()),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  assert.deepEqual(seen.seo_review?.dimensions, {
    evidence: 55,
    position: 40,
    structure: 54,
    citability: 71,
    links: 88,
  });
  assert.equal(seen.seo_review?.competitorDelta?.verdict, 'adds-nothing');
  assert.deepEqual(seen.seo_review?.competitorDelta?.additions, []);
  assert.deepEqual(seen.seo_review?.claimAudit, { checked: 18, unsupported: 3 });
  assert.equal(seen.seo_review?.positionCheck?.recommendsEverythingEqually, true);
  // The panel keeps reading these three keys off the review, contract A.
  assert.deepEqual(seen.seo_review?.slop, { score: 92, words: 1840, findings: 2 });

  const summary = summariseReview(seen.seo_review!);
  assert.match(summary, /evidence 55 · position 40 · structure 54 · citability 71 · links 88/);
  assert.match(summary, /vs top 3: adds-nothing/);
  assert.match(summary, /3\/18 specifics unsupported/);
  assert.match(summary, /FAIL \(6 issues\)/);
});

test('a review written before the restructure still renders its own axes', { skip }, async () => {
  const legacy = {
    score: 84,
    pass: true,
    summary: 'Solid.',
    issues: [],
    dimensions: { seo: 88, geo: 80, voice: 84, eeat: 86, links: 90 },
    slop: { score: 96, words: 1500, findings: 1 },
    forcedThrough: true,
  };
  const article = await insertArticle({
    stage: 'assemble',
    status: 'queued',
    seo_review: JSON.stringify(legacy),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  // links is the one axis that survived the restructure, so it leads; the four
  // retired ones follow in their old reading order.
  const summary = summariseReview(seen.seo_review!);
  assert.match(summary, /links 90 · seo 88 · geo 80 · voice 84 · eeat 86/);
  assert.doesNotMatch(summary, /undefined/);
  assert.doesNotMatch(summary, /vs top/, 'a pre-restructure review has no delta to report');
  assert.match(summary, /max revisions reached/, 'forcedThrough still reads through');
});

test('the editor works from the row, most severe first, with scan hits dropped', { skip }, async () => {
  const article = await insertArticle({
    stage: 'edit',
    status: 'queued',
    seo_review: JSON.stringify(review()),
  });
  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);

  const issues = issuesForEditor(row.seo_review);
  assert.deepEqual(
    issues.map((i) => i.severity),
    ['high', 'high', 'medium', 'low'],
    'scan issues are dropped in both prefix spellings, and the rest are severity-ordered',
  );
  assert.ok(issues.every((i) => !/Voice scan/.test(i.issue)));
  assert.ok(issues.some((i) => i.issue.startsWith(ISSUE_PREFIX.claim)));
  assert.ok(issues.some((i) => i.issue.startsWith(ISSUE_PREFIX.delta)));
});

test('admin feedback on a published article hands the editor a legacy review', { skip }, async () => {
  // The real path an old review reaches the editor by: an operator types
  // feedback on a done article, the route sends it back to edit, and the stage
  // reads whatever review the row has been carrying since before the rebuild.
  const legacy = {
    score: 81,
    pass: true,
    summary: 'Fine.',
    dimensions: { seo: 84, geo: 78, voice: 88, eeat: 80, links: 90 },
    issues: [
      { severity: 'medium', issue: 'The conclusion does not link the runner-up.', fix: 'Link it.' },
      { severity: 'high', issue: 'Voice scan — AI vocabulary: "delve" ×1 (line 22)', fix: 'Rewrite it.' },
    ],
  };
  const article = await insertArticle({
    stage: 'done',
    status: 'done',
    draft_md: '# Title\n\nA published body.',
    seo_review: JSON.stringify(legacy),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/feedback`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: 'Make it argue something.' }),
    }),
  );
  assert.equal(res.status, 200);

  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.stage, 'edit');
  assert.equal(row.status, 'queued');
  const issues = issuesForEditor(row.seo_review);
  assert.deepEqual(
    issues.map((i) => i.issue),
    ['The conclusion does not link the runner-up.'],
    'the em-dashed scan prefix is still recognised, so the editor is not told it twice',
  );
});

test('an article reviewed before any of this reads back with no review at all', { skip }, async () => {
  const article = await insertArticle({ stage: 'write', status: 'queued' });
  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };
  assert.equal(seen.seo_review, null);
  assert.deepEqual(issuesForEditor(seen.seo_review), []);
});
