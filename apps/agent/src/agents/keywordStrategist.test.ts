// normalizePlan is the guard between an LLM's JSON and four downstream
// prompts. A missing array or a bad enum here would surface as a broken brief
// two stages later, so every field gets a defined shape whatever comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from './keywordStrategist.js';
import type { KeywordPlan } from '../pipeline/types.js';

const opts = { fallbackKeyword: 'budget air fryer', aiAnswer: '', postType: 'guide' };

/** A well-formed plan, for the fields a test isn't exercising. */
function plan(overrides: Partial<KeywordPlan> = {}): KeywordPlan {
  return {
    primaryKeyword: 'best air fryer australia',
    rationale: 'Top three are dated listicles with no price checks.',
    intent: 'Commercial Investigation',
    difficulty: 'Moderate',
    zeroClickRisk: 'Low',
    serpFeatures: ['People Also Ask'],
    winningFormat: 'listicle',
    wordCountTarget: 1800,
    secondaryKeywords: ['air fryer under $300'],
    paaQuestions: ['Are air fryers worth it?'],
    entities: ['Ninja AF160'],
    competitors: [],
    contentGaps: ['No AUD pricing'],
    snippetTarget: { question: 'Which air fryer is best?', format: 'table', answer: 'The Ninja.' },
    currentAiAnswer: '',
    titleOptions: ['Best air fryers in Australia (2026)'],
    metaDescription: 'The three worth buying.',
    rejected: [],
    ...overrides,
  };
}

test('a well-formed plan passes through intact', () => {
  const out = normalizePlan(plan(), opts);
  assert.equal(out.primaryKeyword, 'best air fryer australia');
  assert.equal(out.wordCountTarget, 1800);
  assert.equal(out.snippetTarget.format, 'table');
  assert.deepEqual(out.entities, ['Ninja AF160']);
});

test('an empty keyword falls back to the dossier keyword', () => {
  assert.equal(normalizePlan(plan({ primaryKeyword: '  ' }), opts).primaryKeyword, 'budget air fryer');
});

test('bad enums fall back to the safe middle, not to undefined', () => {
  const out = normalizePlan(
    plan({
      difficulty: 'Impossible' as KeywordPlan['difficulty'],
      zeroClickRisk: '' as KeywordPlan['zeroClickRisk'],
      snippetTarget: { question: 'q', format: 'carousel' as 'paragraph', answer: 'a' },
    }),
    opts,
  );
  assert.equal(out.difficulty, 'Moderate');
  assert.equal(out.zeroClickRisk, 'Medium');
  assert.equal(out.snippetTarget.format, 'paragraph');
});

test('the word count target respects the post type floor', () => {
  assert.equal(normalizePlan(plan({ wordCountTarget: 400 }), opts).wordCountTarget, 1500);
  assert.equal(
    normalizePlan(plan({ wordCountTarget: 400 }), { ...opts, postType: 'article' }).wordCountTarget,
    700,
  );
});

test('a runaway word count target is capped', () => {
  assert.equal(normalizePlan(plan({ wordCountTarget: 25000 }), opts).wordCountTarget, 4000);
});

test('a non-numeric word count target falls back to the floor', () => {
  const out = normalizePlan(plan({ wordCountTarget: 'lots' as unknown as number }), opts);
  assert.equal(out.wordCountTarget, 1500);
});

test('missing arrays come back empty, never undefined', () => {
  const out = normalizePlan({} as KeywordPlan, opts);
  for (const key of ['serpFeatures', 'secondaryKeywords', 'paaQuestions', 'entities', 'competitors', 'contentGaps', 'titleOptions', 'rejected'] as const) {
    assert.ok(Array.isArray(out[key]), `${key} should be an array`);
    assert.equal(out[key].length, 0);
  }
  assert.equal(out.primaryKeyword, 'budget air fryer');
  assert.equal(out.snippetTarget.format, 'paragraph');
  assert.equal(out.winningFormat, 'guide');
});

test('the live generated answer comes from the SERP read, not the model', () => {
  const out = normalizePlan(plan({ currentAiAnswer: 'hallucinated' }), {
    ...opts,
    aiAnswer: 'What Tavily actually returned.',
  });
  assert.equal(out.currentAiAnswer, 'What Tavily actually returned.');
});
