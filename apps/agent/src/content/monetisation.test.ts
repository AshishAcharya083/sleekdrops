// Canary for the intent strings. MONETISED_INTENTS is matched against
// KeywordPlan.intent by two gates (the keyword stage and the assembler), and
// both compare strings — so renaming an intent anywhere would silently stop
// them firing rather than break a build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONETISED_INTENTS } from './contract.js';
import { normalizePlan } from '../agents/keywordStrategist.js';

test('the intent the strategist falls back to is one the gates recognise', () => {
  const plan = normalizePlan({} as never, {
    fallbackKeyword: 'air fryer',
    aiAnswer: '',
    postType: 'guide',
  });
  assert.ok(
    MONETISED_INTENTS.has(plan.intent),
    `normalizePlan defaults to "${plan.intent}", which no gate would match`,
  );
});

test('an informational plan is not treated as monetised', () => {
  const plan = normalizePlan({ intent: 'Informational' } as never, {
    fallbackKeyword: 'k', aiAnswer: '', postType: 'article',
  });
  assert.equal(MONETISED_INTENTS.has(plan.intent), false);
});
