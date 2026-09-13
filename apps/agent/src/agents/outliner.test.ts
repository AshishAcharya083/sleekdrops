// The outliner's deterministic half: everything the pipeline decides about a
// brief rather than the model. The prompt is not testable without a model, but
// this is - and it is where the structure contract is actually enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finaliseBrief } from './outliner.js';
import { shapeById } from '../content/shapes.js';
import type { ArticleShape } from '../content/shapes.js';
import type { ArticleRow, ContentBrief, KeywordPlan } from '../pipeline/types.js';

const shape = (id: string): ArticleShape => shapeById(id) as ArticleShape;

function anArticle(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    topic_id: null,
    title: 'Best cordless stick vacuums',
    slug: null,
    category: 'Home',
    post_type: 'guide',
    stage: 'outline',
    status: 'running',
    revision_round: 0,
    research: null,
    keyword_plan: null,
    editorial_angle: null,
    structure_shape: null,
    outline: null,
    draft_md: null,
    seo_review: null,
    frontmatter: null,
    affiliate_links: null,
    hero_image_url: null,
    hero_alt: null,
    feedback: null,
    error: null,
    published_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function aBrief(overrides: Partial<ContentBrief> = {}): ContentBrief {
  return {
    seoTitle: 'Best cordless stick vacuums in Australia',
    dek: 'What to buy and what breaks.',
    slug: 'Best Cordless Stick Vacuums!',
    author: 'tech',
    kind: 'Buying guide',
    searchIntent: 'Commercial Investigation',
    primaryKeyword: 'cordless stick vacuum',
    secondaryKeywords: [],
    tags: ['vacuums'],
    wordCountTarget: 1500,
    sections: [
      { heading: 'The ranking at a glance', kind: 'ranking', points: ['the order'] },
      { heading: 'How we ranked these', kind: 'criteria', points: ['criteria'] },
      { heading: '1. Shark Detect Pro', kind: 'entry', points: ['why first'] },
      { heading: 'What missed the cut', kind: 'cut', points: ['rejected'] },
      { heading: 'The one to buy', kind: 'top-line', points: ['the call'] },
    ],
    faq: [{ question: 'How long do cordless vacuums last?' }],
    ...overrides,
  };
}

const plan = (overrides: Partial<KeywordPlan> = {}): KeywordPlan =>
  ({
    primaryKeyword: 'best cordless stick vacuum australia',
    wordCountTarget: 1800,
    paaQuestions: ['Are cordless vacuums worth it?', 'How long do the batteries last?', 'Which brand lasts longest?'],
    ...overrides,
  }) as KeywordPlan;

test('the brief carries the shape downstream', () => {
  // The writer and the SEO reviewer both serialise the whole brief into their
  // prompt, so this embedding is the only thing that gets the shape to them.
  const brief = finaliseBrief(aBrief(), {
    article: anArticle(),
    plan: null,
    shape: shape('ranked-list'),
  });
  assert.equal(brief.structureShape?.id, 'ranked-list');
  assert.equal(brief.structureShape?.faq, 'required');
});

test('the deterministic post-processing survives the rewrite', () => {
  const article = anArticle({
    editorial_angle: { byline: 'home' } as ArticleRow['editorial_angle'],
  });
  const brief = finaliseBrief(aBrief(), { article, plan: plan(), shape: shape('ranked-list') });
  assert.equal(brief.slug, 'best-cordless-stick-vacuums');
  assert.equal(brief.author, 'home', 'the byline is the angle stage\'s pick');
  assert.equal(brief.primaryKeyword, 'best cordless stick vacuum australia');
  assert.equal(brief.wordCountTarget, 1800);
});

test('an unknown byline falls back to the beat that owns the category', () => {
  const article = anArticle({
    category: 'Home',
    editorial_angle: { byline: 'nobody' } as ArticleRow['editorial_angle'],
  });
  const brief = finaliseBrief(aBrief(), { article, plan: null, shape: shape('ranked-list') });
  assert.equal(brief.author, 'home');
});

test('the slug falls back to the title when the model returned none', () => {
  const brief = finaliseBrief(aBrief({ slug: '' }), {
    article: anArticle(),
    plan: null,
    shape: shape('ranked-list'),
  });
  assert.equal(brief.slug, 'best-cordless-stick-vacuums-in-australia');
});

// ------------------------------------------------------------- passage budget

test('the passage budget is a hard cap, not a suggestion', () => {
  // A model asked for three extractable answers will sometimes flag every
  // section - which is the uniform per-H2 block the library replaced.
  const sections = aBrief().sections.map((s) => ({ ...s, extractable: true }));
  const brief = finaliseBrief(aBrief({ sections }), {
    article: anArticle(),
    plan: null,
    shape: shape('ranked-list'),
  });
  const spent = brief.sections.filter((s) => s.extractable);
  assert.equal(spent.length, 3);
  assert.deepEqual(
    spent.map((s) => s.kind),
    ['ranking', 'cut', 'top-line'],
    'the budget goes to the kinds the shape marks, not the first three headings',
  );
});

test('every section carries an explicit extractable flag once finalised', () => {
  const brief = finaliseBrief(aBrief(), {
    article: anArticle(),
    plan: null,
    shape: shape('ranked-list'),
  });
  for (const section of brief.sections) assert.equal(typeof section.extractable, 'boolean');
});

test('a model that flagged nothing still gets its budget spent', () => {
  const brief = finaliseBrief(aBrief(), {
    article: anArticle(),
    plan: null,
    shape: shape('verdict-first'),
  });
  assert.equal(brief.sections.filter((s) => s.extractable).length, 3);
});

test('sections the model marked false are not overridden into the budget', () => {
  const sections = aBrief().sections.map((s) => ({
    ...s,
    extractable: s.kind === 'ranking' || s.kind === 'cut',
  }));
  const brief = finaliseBrief(aBrief({ sections }), {
    article: anArticle(),
    plan: null,
    shape: shape('ranked-list'),
  });
  assert.deepEqual(
    brief.sections.filter((s) => s.extractable).map((s) => s.kind),
    ['ranking', 'cut'],
  );
});

test('headless sections are dropped rather than outlined', () => {
  const brief = finaliseBrief(
    aBrief({ sections: [...aBrief().sections, { heading: '  ', points: [] }] }),
    { article: anArticle(), plan: null, shape: shape('ranked-list') },
  );
  assert.equal(brief.sections.length, 5);
});

// ------------------------------------------------------------------- the FAQ

test('a shape that requires an FAQ never gets an empty one', () => {
  // The site parses the visible "## FAQ" into FAQPage markup, so a shape that
  // promises one has to deliver questions.
  const brief = finaliseBrief(aBrief({ faq: [] }), {
    article: anArticle(),
    plan: plan(),
    shape: shape('ranked-list'),
  });
  assert.equal(brief.faq.length, 3);
  assert.equal(brief.faq[0].question, 'Are cordless vacuums worth it?');
});

test('a shape that omits the FAQ gets none, whatever the model returned', () => {
  // The old "never let the FAQ come back empty" rule applied to every shape
  // would put a populated faq[] on a piece whose H2s are already questions,
  // the writer would emit the section, and the uniformity would come back.
  const brief = finaliseBrief(aBrief({ faq: [{ question: 'Do these last?' }] }), {
    article: anArticle({ post_type: 'article' }),
    plan: plan(),
    shape: shape('question-led'),
  });
  assert.deepEqual(brief.faq, []);
});

test('an optional FAQ is left exactly as the outline judged it', () => {
  const withEntries = finaliseBrief(aBrief({ faq: [{ question: 'Does it clog?' }] }), {
    article: anArticle(),
    plan: plan(),
    shape: shape('verdict-first'),
  });
  assert.deepEqual(withEntries.faq, [{ question: 'Does it clog?' }]);

  const withNone = finaliseBrief(aBrief({ faq: [] }), {
    article: anArticle(),
    plan: plan(),
    shape: shape('verdict-first'),
  });
  assert.deepEqual(withNone.faq, [], 'an optional FAQ is not back-filled from the PAA list');
});

test('blank FAQ entries are dropped', () => {
  const brief = finaliseBrief(
    aBrief({ faq: [{ question: '  ' }, { question: 'Does it clog?' }] }),
    { article: anArticle(), plan: plan(), shape: shape('segmented-buyers') },
  );
  assert.deepEqual(brief.faq, [{ question: 'Does it clog?' }]);
});

test('a required FAQ with no PAA questions to fall back on comes back empty, not invented', () => {
  const brief = finaliseBrief(aBrief({ faq: [] }), {
    article: anArticle(),
    plan: plan({ paaQuestions: [] }),
    shape: shape('ranked-list'),
  });
  assert.deepEqual(brief.faq, []);
});
