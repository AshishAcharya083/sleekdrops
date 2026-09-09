// The dossier contract. Products are the affiliate table — a guide that
// reaches the assembler without them publishes with nothing to click, which
// is the one failure mode that costs revenue rather than quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dossierCheck, groupEvidence, planStrata } from './researcher.js';
import type { ResearchDossier } from '../pipeline/types.js';

const complete: ResearchDossier = {
  summary: 'The 2026 Galaxy Z line, and which of the three to buy.',
  facts: [
    { fact: 'Announced 22 July 2026', sourceUrl: 'https://news.samsung.com/au/x',
      tier: 'primary', date: '2026-07-22' },
  ],
  products: [
    { name: 'Galaxy Z Fold 8', brand: 'Samsung', approxPrice: 'A$2,699',
      amazonUrl: null, goSlug: 'galaxy-z-fold-8', notes: '' },
  ],
  failureModes: [],
  whoShouldNotBuy: [],
  ownerComplaints: [],
  priceObservations: [],
  testedClaims: [],
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

test('a dossier that simply omits the owner-experience strata is rejected', () => {
  // Omitted and "we looked and found none" are indistinguishable downstream,
  // and only the second is honest - so the model has to say which it is.
  const { ownerComplaints, failureModes, ...thin } = complete;
  const complaint = String(dossierCheck('guide')(thin));
  assert.match(complaint, /"failureModes"/);
  assert.match(complaint, /"ownerComplaints"/);
  assert.doesNotMatch(complaint, /"priceObservations"/);
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
    dossierCheck('article')({ ...complete, facts: [], summary: '', keywords: { primary: '', secondary: [] } }),
  );
  assert.match(complaint, /facts/);
  assert.match(complaint, /summary/);
  assert.match(complaint, /keywords\.primary/);
});

// ── Stratified planning ─────────────────────────────────────────────────────
// The evidence gate can only find owner complaints the search stage went
// looking for, so a stratum that quietly plans no queries is the failure that
// makes every downstream count zero.

test('every stratum gets queries, even the ones the planner skipped', () => {
  const planned = planStrata(
    { primary: ['dyson v15 specifications'], owner: [] },
    'Best cordless stick vacuums',
  );

  assert.deepEqual(
    planned.map((s) => s.key),
    ['primary', 'expert', 'owner', 'price', 'competing'],
  );
  assert.deepEqual(planned[0].queries, ['dyson v15 specifications']);
  assert.match(planned[2].queries[0], /productreview\.com\.au/);
  assert.match(planned[3].queries[0], /price australia/);
  assert.ok(planned.every((s) => s.queries.length > 0));
});

test('a planner reply wrapped in the old "queries" key is still read', () => {
  const planned = planStrata(
    { queries: { owner: ['v15 clutch failure reddit', 'v15 battery 6 months'] } },
    'Best cordless stick vacuums',
  );
  assert.deepEqual(planned[2].queries, ['v15 clutch failure reddit', 'v15 battery 6 months']);
});

test('a planner reply of the wrong shape falls back rather than searching nothing', () => {
  for (const reply of [null, ['a', 'b'], { queries: ['a', 'b'] }, 'nope']) {
    const planned = planStrata(reply, 'Beef tallow skincare');
    assert.ok(planned.every((s) => s.queries.length > 0), `${JSON.stringify(reply)} left a stratum blank`);
  }
});

test('a stratum takes at most two queries, and blank ones do not count', () => {
  const planned = planStrata({ expert: ['  ', 'a', 'b', 'c', 42] }, 'x');
  assert.deepEqual(planned[1].queries, ['a', 'b']);
});

test('evidence reaches the synthesis prompt under its own stratum heading', () => {
  const planned = planStrata({ owner: ['v15 clutch failure reddit'] }, 'x');
  const grouped = groupEvidence(planned, [
    {
      query: 'v15 clutch failure reddit',
      results: [{ title: 'Clutch gone at 8 months', url: 'https://reddit.com/x', content: 'mine too' }],
    },
  ]);

  const ownerBlock = grouped.slice(grouped.indexOf('## OWNER REVIEWS'));
  assert.match(ownerBlock, /Clutch gone at 8 months/);
  // The primary block ran no search here, and says so rather than borrowing
  // the owner results.
  const primaryBlock = grouped.slice(grouped.indexOf('## PRIMARY'), grouped.indexOf('## INDEPENDENT'));
  assert.match(primaryBlock, /\(no results\)/);
  assert.doesNotMatch(primaryBlock, /Clutch gone/);
});
