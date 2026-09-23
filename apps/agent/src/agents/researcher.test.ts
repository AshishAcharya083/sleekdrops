// The dossier contract. Products are the affiliate table — a guide that
// reaches the assembler without them publishes with nothing to click, which
// is the one failure mode that costs revenue rather than quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dossierCheck,
  groupEvidence,
  mergeDossier,
  planStrata,
  resweepPlan,
  sweepUntilSufficient,
} from './researcher.js';
import { EvidenceGateError } from '../content/evidence.js';
import type { ArticleRow, ResearchDossier } from '../pipeline/types.js';

const complete: ResearchDossier = {
  summary: 'The 2026 Galaxy Z line, and which of the three to buy.',
  facts: [
    { fact: 'Announced 22 July 2026', sourceUrl: 'https://news.samsung.com/au/x',
      tier: 'primary', date: '2026-07-22', publisher: 'Samsung' },
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

// ── The targeted re-sweep ────────────────────────────────────────────────────
// Research used to be one shot: plan, synthesise, count, die. One thin stratum
// - the iPhone 18 piece failed on expert facts 1 of 2, for a product with
// hundreds of published articles behind it - was a terminal card. A shortfall
// now buys exactly one more sweep, scoped to the strata that were short.

/** A guide dossier that clears every stratum, used as the baseline to break. */
function sufficient(): ResearchDossier {
  const fact = (n: number, tier: 'primary' | 'expert' | 'owner') => ({
    fact: `${tier} fact ${n}`,
    sourceUrl: `https://example.com/${tier}/${n}`,
    tier,
    date: '2026-04-01',
    publisher: 'Choice',
  });
  return {
    summary: 'Which cordless stick vacuum to buy in Australia.',
    facts: [
      fact(1, 'primary'), fact(2, 'primary'), fact(3, 'primary'), fact(4, 'primary'),
      fact(1, 'expert'), fact(2, 'expert'), fact(3, 'expert'),
      fact(1, 'owner'), fact(2, 'owner'), fact(3, 'owner'),
    ],
    products: [{ name: 'Dyson V15 Detect', brand: 'Dyson', approxPrice: 'A$1,549',
      amazonUrl: null, goSlug: 'dyson-v15-detect', notes: '' }],
    failureModes: [1, 2, 3].map((n) => ({ product: 'Dyson V15 Detect', failure: `clutch slips ${n}`,
      timeframe: 'after 6-12 months', sourceUrl: `https://productreview.com.au/f/${n}`, tier: 'owner' as const })),
    whoShouldNotBuy: [{ audience: 'anyone vacuuming a three-storey townhouse',
      reason: 'the run time does not cover a three-bedroom house', sourceUrl: 'https://productreview.com.au/w/1' }],
    ownerComplaints: [1, 2, 3, 4].map((n) => ({ product: 'Dyson V15 Detect',
      complaint: `battery drops to nine minutes ${n}`, volume: 'recurring' as const, recency: '2026-03',
      denominator: `${n}7 of 412 reviews`, kind: 'quoted' as const, sourceUrl: `https://reddit.com/r/v/${n}` })),
    priceObservations: [1, 2, 3].map((n) => ({ product: 'Dyson V15 Detect', value: 1199 + n,
      currency: 'AUD', retailer: 'JB Hi-Fi', dateChecked: '2026-04-02', sourceUrl: `https://jbhifi.com.au/${n}` })),
    testedClaims: [1, 2].map((n) => ({ claim: `210AW on high ${n}`, source: 'Choice', year: 2026,
      sourceUrl: `https://choice.com.au/t/${n}` })),
    keywords: { primary: 'cordless stick vacuum', secondary: [] },
    competitorNotes: 'The ranking pages restate the spec sheet and never open a warranty claim.',
    faqIdeas: [],
  };
}

const guideArticle = { title: 'Best cordless stick vacuums', post_type: 'guide', category: 'Home' } as ArticleRow;

test('a dossier that already clears the bar never pays for a second sweep', async () => {
  let sweeps = 0;
  const dossier = await sweepUntilSufficient(sufficient(), guideArticle, async () => {
    sweeps += 1;
    return {};
  });
  assert.equal(sweeps, 0);
  assert.equal(dossier.sufficiency?.pass, true);
});

test('one thin stratum buys a second sweep and the piece survives it', async () => {
  // The iPhone 18 failure, in miniature: expert facts one short, everything
  // else filed. Under the old shape this was a dead card.
  const thin = sufficient();
  thin.facts = thin.facts.filter((f) => f.fact !== 'expert fact 3');

  let asked: string[] = [];
  const dossier = await sweepUntilSufficient(thin, guideArticle, async (shortfalls) => {
    asked = shortfalls.map((s) => s.stratum);
    return {
      facts: [{ fact: 'GSMArena measured 210AW on high', sourceUrl: 'https://www.gsmarena.com/x',
        tier: 'expert', date: '2026-09-16', publisher: 'GSMArena' }],
    };
  });

  assert.deepEqual(asked, ['expert']);
  assert.equal(dossier.sufficiency?.pass, true);
  assert.equal(dossier.facts.length, 10, 'the first pass’s evidence is added to, never replaced');
  assert.equal(dossier.facts.at(-1)?.publisher, 'GSMArena');
});

test('a second sweep that comes up empty is still the end of the line', async () => {
  const thin = sufficient();
  thin.facts = thin.facts.filter((f) => f.tier !== 'expert');
  let sweeps = 0;
  await assert.rejects(
    sweepUntilSufficient(thin, guideArticle, async () => {
      sweeps += 1;
      return { facts: [] };
    }),
    (err: unknown) => err instanceof EvidenceGateError && /facts from independent expert reviews/.test(String(err.message)),
  );
  assert.equal(sweeps, 1, 'bounded to one attempt, by construction rather than by a counter');
});

test('the re-sweep asks the strata that were thin, and no others', () => {
  const planned = resweepPlan(
    [
      { stratum: 'expert', label: 'x', have: 1, need: 2, fix: '' },
      { stratum: 'expert', label: 'y', have: 0, need: 1, fix: '' },
    ],
    'iPhone 18 Pro',
  );
  assert.deepEqual(planned.map((p) => p.key), ['expert']);
  assert.equal(planned[0].queries.length, 2);
  // Derived from the stratum, not from the plan that just came up short -
  // re-running the first plan's phrasing buys another set of the same results.
  assert.match(planned[0].queries.join(' '), /gsmarena|notebookcheck/i);
});

test('a re-sweep may only add to the strata that were short', () => {
  const base = sufficient();
  const merged = mergeDossier(
    base,
    {
      facts: [{ fact: 'new expert fact', sourceUrl: 'https://x.test/1', tier: 'expert', date: null, publisher: 'GSMArena' }],
      priceObservations: [{ product: 'p', value: 99, currency: 'AUD', retailer: 'Kogan',
        dateChecked: '2026-09-01', sourceUrl: 'https://kogan.com/1' }],
      competitorNotes: 'a much longer competing-coverage read than the one already filed, with detail',
    },
    [{ stratum: 'expert', label: 'x', have: 1, need: 2, fix: '' }],
  );
  assert.equal(merged.facts.length, base.facts.length + 1);
  assert.equal(merged.priceObservations.length, base.priceObservations.length, 'the price stratum was not thin');
  assert.equal(merged.competitorNotes, base.competitorNotes, 'nor was the competing read');
});

test('a second sweep that re-finds the same page does not get counted twice', () => {
  const base = sufficient();
  const merged = mergeDossier(
    base,
    { facts: [{ ...base.facts[4] }, { fact: 'genuinely new', sourceUrl: 'https://x.test/9', tier: 'expert', date: null, publisher: null }] },
    [{ stratum: 'expert', label: 'x', have: 1, need: 2, fix: '' }],
  );
  assert.equal(merged.facts.length, base.facts.length + 1);
});

test('a release date the first pass missed is carried through - it decides the window', () => {
  const base = sufficient();
  const merged = mergeDossier(
    base,
    { launch: { product: 'Dyson V15 Detect', releaseDate: '2026-09-01', sourceUrl: 'https://dyson.com.au' } },
    [{ stratum: 'expert', label: 'x', have: 1, need: 2, fix: '' }],
  );
  assert.equal(merged.launch?.releaseDate, '2026-09-01');
});

test('a re-sweep that falls over propagates its own fault, never the gate’s verdict', async () => {
  // A timeout is not a verdict on the evidence: nothing was counted a second
  // time. EvidenceGateError means "the re-sweep ran and the counts were still
  // short", and it is terminal on that basis - so a transient fault dressed up
  // as one would fail the card for a reason that was never checked, and spend
  // the stage retry it was owed.
  const thin = sufficient();
  thin.facts = thin.facts.filter((f) => f.tier !== 'expert');
  const upstream = new Error('upstream timed out');
  await assert.rejects(
    sweepUntilSufficient(thin, guideArticle, async () => {
      throw upstream;
    }),
    (err: unknown) => err === upstream && !(err instanceof EvidenceGateError),
  );
});
