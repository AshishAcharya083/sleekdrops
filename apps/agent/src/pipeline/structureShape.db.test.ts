// The structure library where it actually lands: a real Postgres column, the
// brief JSONB that carries the shape into the writer's and reviewer's prompts,
// and the admin API the operator panel reads it back through.
//
// The unit tests in content/shapes.test.ts and agents/outliner.test.ts prove
// selection and the deterministic structure contract. They cannot prove that
// migration 009 ran, that `structure_shape` survives the JSONB round trip with
// its sections intact, that the writer finds the shape on the brief it is
// handed off the row, or that an article outlined before the library existed
// still reads back cleanly. All four only happen against the database. Point
// DATABASE_URL at a throwaway server to run these.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { createApp } = await import('../api/server.js');
const { finaliseBrief } = await import('../agents/outliner.js');
const { selectShape, structureBrief } = await import('../content/shapes.js');

import type { ArticleRow, ContentBrief, EditorialAngle, KeywordPlan } from './types.js';

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

const angle = (shape: EditorialAngle['shape']): EditorialAngle => ({
  thesis: 'The Dyson is the wrong buy above A$1,000.',
  reader: 'Someone replacing a corded vacuum in a flat with no carpet',
  defensible: true,
  contrarianTake: 'The one every roundup ranks first is the one owners replace in year two.',
  weakness: '',
  informationGain: [],
  shape,
  shapeRationale: 'The failure data is what the top three do not have.',
  byline: 'home',
  bylineRationale: 'A durability argument about an appliance.',
});

const plan = (): KeywordPlan =>
  ({
    primaryKeyword: 'best cordless stick vacuum australia',
    winningFormat: 'Ranked listicle',
    intent: 'Commercial Investigation',
    wordCountTarget: 1800,
    paaQuestions: ['Are cordless vacuums worth it?', 'Which brand lasts longest?'],
  }) as KeywordPlan;

function aBrief(): ContentBrief {
  return {
    seoTitle: 'Best cordless stick vacuums in Australia',
    dek: 'What to buy and what breaks.',
    slug: 'best-cordless-stick-vacuums',
    author: 'home',
    kind: 'Buying guide',
    searchIntent: 'Commercial Investigation',
    primaryKeyword: 'cordless stick vacuum',
    secondaryKeywords: [],
    tags: ['vacuums'],
    wordCountTarget: 1500,
    sections: [
      { heading: 'What goes wrong', kind: 'fault', points: ['the clutch'] },
      { heading: 'Why it happens', kind: 'cause', points: ['the mechanism'] },
      { heading: 'What survives it', kind: 'survivors', points: ['the picks'] },
      { heading: 'Where these numbers come from', kind: 'evidence-trail', points: ['sources'] },
      { heading: 'If you already own one', kind: 'if-you-own-one', points: ['warranty'] },
    ],
    faq: [],
  };
}

test('the shape survives JSONB and reaches the panel whole', { skip }, async () => {
  // The admin panel renders these fields straight out of the column. A round
  // trip that flattened `sections` or dropped the passage budget would only
  // ever show up here.
  const shape = selectShape({ postType: 'guide', angle: angle('failure-led') });
  const article = await insertArticle({
    stage: 'write',
    status: 'queued',
    structure_shape: JSON.stringify(shape),
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  assert.equal(res.status, 200);
  const { article: seen } = (await res.json()) as { article: ArticleRow };

  assert.deepEqual(seen.structure_shape, shape);
  assert.equal(seen.structure_shape?.id, 'failure-led');
  assert.equal(seen.structure_shape?.selectedBy, 'angle');
  assert.equal(seen.structure_shape?.passageBudget.passages, 3);
  assert.ok(seen.structure_shape?.sections.some((s) => s.kind === 'evidence-trail'));

  // The shape read back off the wire is what a prompt gets built from, so
  // build one from it rather than from the object we wrote.
  const brief = structureBrief(seen.structure_shape);
  assert.match(brief, /"Problem-first diagnostic" shape \(failure-led\)/);
  assert.match(brief, /Open on the failure/);
  assert.match(brief, /3 extractable answers/);
});

test('the brief carries the shape into the writer and reviewer prompts', { skip }, async () => {
  // Both stages serialise `article.outline` into their prompt. Embedding the
  // shape there is what gets it downstream with no call-site changes, so what
  // matters is that it is still there after the outline column round trip.
  const article = await insertArticle({ stage: 'write', status: 'queued' });
  const shape = selectShape({
    postType: 'guide',
    angle: angle('failure-led'),
    winningFormat: 'Ranked listicle',
  });
  const brief = finaliseBrief(aBrief(), { article, plan: plan(), shape });

  await q('UPDATE articles SET outline = $2, structure_shape = $3 WHERE id = $1', [
    article.id,
    JSON.stringify(brief),
    JSON.stringify(shape),
  ]);

  const [row] = await q<ArticleRow>('SELECT * FROM articles WHERE id = $1', [article.id]);
  assert.equal(row.outline?.structureShape?.id, 'failure-led');
  assert.deepEqual(row.outline?.structureShape, row.structure_shape);
  // The passage budget the writer prints into its prompt is a cap the outline
  // already spent, so the two cannot disagree.
  const spent = (row.outline?.sections ?? []).filter((s) => s.extractable);
  assert.equal(spent.length, shape.passageBudget.passages);
  assert.deepEqual(
    spent.map((s) => s.kind),
    ['fault', 'cause', 'survivors'],
  );
  // failure-led leaves the FAQ optional, and this outline had no questions to
  // ask - so no FAQ entries are invented on the way through.
  assert.deepEqual(row.outline?.faq, []);
});

test('articles outlined before the library existed read back with no shape', { skip }, async () => {
  const article = await insertArticle({ stage: 'write', status: 'queued' });
  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}`, { headers: AUTH }),
  );
  const { article: seen } = (await res.json()) as { article: ArticleRow };
  assert.equal(seen.structure_shape, null);
  assert.equal(structureBrief(seen.structure_shape), '', 'no shape means no structure block');
});
