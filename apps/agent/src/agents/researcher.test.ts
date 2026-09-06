// The dossier contract. Products are the affiliate table — a guide that
// reaches the assembler without them publishes with nothing to click, which
// is the one failure mode that costs revenue rather than quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dossierCheck } from './researcher.js';
import type { ResearchDossier } from '../pipeline/types.js';

const complete: ResearchDossier = {
  summary: 'The 2026 Galaxy Z line, and which of the three to buy.',
  facts: [{ fact: 'Announced 22 July 2026', sourceUrl: 'https://news.samsung.com/au/x' }],
  products: [
    { name: 'Galaxy Z Fold 8', brand: 'Samsung', approxPrice: 'A$2,699',
      amazonUrl: null, goSlug: 'galaxy-z-fold-8', notes: '' },
  ],
  keywords: { primary: 'galaxy z fold 8 vs z flip 8', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

test('a complete dossier passes', () => {
  assert.equal(dossierCheck('guide')(complete), null);
});

test('the bare facts array that shipped to production is rejected', () => {
  const asShipped = [
    { fact: 'Announced 22 July 2026', sourceUrl: 'https://news.samsung.com/au/x' },
    { fact: 'Three models in the lineup', sourceUrl: 'https://samsung.com/au/y' },
  ];
  assert.match(String(dossierCheck('guide')(asShipped)), /you returned one field instead of the object/);
});

test('a guide with no products is rejected — that is an empty affiliate table', () => {
  const noProducts = { ...complete, products: [] };
  assert.match(String(dossierCheck('guide')(noProducts)), /products/);
  assert.match(String(dossierCheck('roundup')(noProducts)), /products/);
});

test('a plain article may legitimately have no products', () => {
  assert.equal(dossierCheck('article')({ ...complete, products: [] }), null);
});

test('empty facts, a missing summary and a missing keyword are all named at once', () => {
  const complaint = String(
    dossierCheck('article')({ facts: [], products: [], keywords: { primary: '', secondary: [] } }),
  );
  assert.match(complaint, /facts/);
  assert.match(complaint, /summary/);
  assert.match(complaint, /keywords\.primary/);
});
