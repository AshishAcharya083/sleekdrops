// The deterministic half of the research stage. No model, no Tavily: the
// point of moving normalisation and the sufficiency bar out of the prompt is
// that both are now checkable the same way twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barFor, checkEvidence, countEvidence, normaliseDate, normaliseDossier } from './evidence.js';
import type { ResearchDossier } from '../pipeline/types.js';

/** A guide dossier that clears every stratum, used as the baseline to break. */
function sufficientGuide(): ResearchDossier {
  const fact = (n: number, tier: 'primary' | 'expert' | 'owner') => ({
    fact: `${tier} fact ${n}`,
    sourceUrl: `https://example.com/${tier}/${n}`,
    tier,
    date: '2026-04-01',
  });
  return {
    summary: 'Which cordless stick vacuum to buy in Australia, and which to avoid.',
    facts: [
      fact(1, 'primary'), fact(2, 'primary'), fact(3, 'primary'), fact(4, 'primary'),
      fact(1, 'expert'), fact(2, 'expert'), fact(3, 'expert'),
      fact(1, 'owner'), fact(2, 'owner'), fact(3, 'owner'),
    ],
    products: [
      { name: 'Dyson V15 Detect', brand: 'Dyson', approxPrice: 'RRP A$1,549',
        amazonUrl: null, goSlug: 'dyson-v15-detect', notes: '' },
    ],
    failureModes: [1, 2, 3].map((n) => ({
      product: 'Dyson V15 Detect',
      failure: `clutch slips ${n}`,
      timeframe: 'after 6-12 months',
      sourceUrl: `https://productreview.com.au/f/${n}`,
      tier: 'owner' as const,
    })),
    whoShouldNotBuy: [1, 2].map((n) => ({
      audience: `buyer ${n}`,
      reason: 'the run time does not cover a three-bedroom house',
      sourceUrl: `https://productreview.com.au/w/${n}`,
    })),
    ownerComplaints: [1, 2, 3, 4].map((n) => ({
      product: 'Dyson V15 Detect',
      complaint: `battery drops to nine minutes ${n}`,
      volume: 'recurring' as const,
      recency: '2026-03',
      sourceUrl: `https://reddit.com/r/vacuums/${n}`,
    })),
    priceObservations: [1, 2, 3].map((n) => ({
      product: 'Dyson V15 Detect',
      value: 1149 + n,
      currency: 'AUD',
      retailer: 'The Good Guys',
      dateChecked: '2026-09-01',
      sourceUrl: `https://thegoodguys.com.au/p/${n}`,
    })),
    testedClaims: [1, 2].map((n) => ({
      claim: `suction measured at ${n}00AW on carpet`,
      source: 'Choice',
      year: 2026,
      sourceUrl: `https://choice.com.au/t/${n}`,
    })),
    keywords: { primary: 'best cordless stick vacuum australia', secondary: [] },
    competitorNotes:
      'The top three pages all rank the same five machines on RRP and run time, and none of them mention the clutch failures.',
    faqIdeas: [],
  };
}

// ── The sufficiency gate ────────────────────────────────────────────────────

test('a dossier that clears every stratum passes, and says so', () => {
  const verdict = checkEvidence(sufficientGuide(), 'guide');
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.shortfalls, []);
  assert.match(verdict.message, /Evidence sufficient for a guide/);
  assert.equal(verdict.postType, 'guide');
});

test('the flagged shape - plenty of specs, no owner experience - fails a guide', () => {
  // This is the Beef tallow / stick vacuum / Bluetooth speaker dossier: a wall
  // of manufacturer facts and nothing a spec sheet could not have said.
  const specsOnly: ResearchDossier = {
    ...sufficientGuide(),
    failureModes: [],
    whoShouldNotBuy: [],
    ownerComplaints: [],
    priceObservations: [],
    testedClaims: [],
  };
  const verdict = checkEvidence(specsOnly, 'guide');

  assert.equal(verdict.pass, false);
  const short = verdict.shortfalls.map((s) => s.label);
  assert.ok(short.some((l) => l.includes('owner complaints')));
  assert.ok(short.some((l) => l.includes('failure modes')));
  assert.ok(short.some((l) => l.includes('dated price observations')));
  assert.ok(short.some((l) => l.includes('tested claims')));
  // Actionable, not just a verdict: it names where each thin stratum lives.
  assert.match(verdict.message, /owner complaints 0\/4/);
  assert.match(verdict.message, /productreview\.com\.au/i);
  assert.match(verdict.message, /- price:/);
});

test('every shortfall carries have, need and where to gather it', () => {
  const verdict = checkEvidence({ ...sufficientGuide(), ownerComplaints: [] }, 'guide');
  const complaints = verdict.shortfalls.find((s) => s.label === 'owner complaints');

  assert.ok(complaints);
  assert.equal(complaints.stratum, 'owner');
  assert.equal(complaints.have, 0);
  assert.equal(complaints.need, barFor('guide').ownerComplaints);
  assert.match(complaints.fix, /ProductReview/);
});

test('untiered facts do not count toward any stratum', () => {
  const untiered: ResearchDossier = {
    ...sufficientGuide(),
    facts: sufficientGuide().facts.map((f) => ({ ...f, tier: 'unknown' as const })),
  };
  const verdict = checkEvidence(untiered, 'guide');

  assert.equal(verdict.pass, false);
  assert.equal(verdict.counts.untieredFacts, 10);
  assert.equal(verdict.counts.primaryFacts, 0);
  assert.ok(verdict.shortfalls.some((s) => s.stratum === 'primary'));
});

test('an aggregator-only dossier fails - restated numbers are not primary evidence', () => {
  const secondHand: ResearchDossier = {
    ...sufficientGuide(),
    facts: sufficientGuide().facts.map((f) => ({ ...f, tier: 'aggregator' as const })),
  };
  const verdict = checkEvidence(secondHand, 'guide');

  assert.equal(verdict.pass, false);
  assert.equal(verdict.counts.aggregatorFacts, 10);
  assert.ok(verdict.shortfalls.some((s) => s.label.includes('primary source')));
});

test('an undated price observation does not count as a price observation', () => {
  const undated: ResearchDossier = {
    ...sufficientGuide(),
    priceObservations: sufficientGuide().priceObservations.map((o) => ({ ...o, dateChecked: null })),
  };
  const verdict = checkEvidence(undated, 'guide');

  assert.equal(verdict.counts.priceObservations, 3);
  assert.equal(verdict.counts.datedPriceObservations, 0);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.shortfalls.some((s) => s.stratum === 'price'));
});

test('the bar is per post type - a trend article is not held to a guide bar', () => {
  // A piece about a product announced last week has no owners yet, so the
  // article bar asks for sourcing depth instead of owner experience.
  const trendPiece: ResearchDossier = {
    ...sufficientGuide(),
    failureModes: [],
    whoShouldNotBuy: [],
    priceObservations: [],
    testedClaims: [],
    ownerComplaints: [],
    facts: sufficientGuide().facts.filter((f) => f.tier !== 'owner'),
  };
  assert.equal(checkEvidence(trendPiece, 'article').pass, true);
  assert.equal(checkEvidence(trendPiece, 'guide').pass, false);
});

test('an article still has to be sourced, not just short', () => {
  const thin: ResearchDossier = {
    ...sufficientGuide(),
    facts: sufficientGuide().facts.filter((f) => f.tier === 'primary').slice(0, 2),
  };
  const verdict = checkEvidence(thin, 'article');
  assert.equal(verdict.pass, false);
  assert.deepEqual(
    verdict.shortfalls.map((s) => s.stratum),
    ['primary', 'expert'],
  );
});

test('an unknown post type is held to the article bar rather than to nothing', () => {
  assert.deepEqual(barFor('listicle'), barFor('article'));
  assert.equal(checkEvidence({ ...sufficientGuide(), facts: [] }, 'listicle').pass, false);
});

test('a missing competing-coverage read is its own shortfall', () => {
  const verdict = checkEvidence({ ...sufficientGuide(), competitorNotes: 'thin' }, 'guide');
  assert.equal(verdict.counts.competingCoverage, 0);
  assert.ok(verdict.shortfalls.some((s) => s.stratum === 'competing'));
});

test('counting a legacy dossier written before the strata existed does not throw', () => {
  const legacy = { summary: 'old', facts: [], keywords: { primary: 'x', secondary: [] } };
  const counts = countEvidence(legacy as unknown as ResearchDossier);
  assert.equal(counts.ownerComplaints, 0);
  assert.equal(counts.competingCoverage, 0);
});

// ── Dossier normalisation ───────────────────────────────────────────────────

test('an unrecognised tier is marked unknown, never promoted', () => {
  const dossier = normaliseDossier({
    facts: [
      { fact: 'a', sourceUrl: 'https://x/a', tier: 'PRIMARY', date: '2026' },
      { fact: 'b', sourceUrl: 'https://x/b', tier: 'manufacturer' },
      { fact: 'c', sourceUrl: 'https://x/c' },
    ],
  });

  assert.deepEqual(dossier.facts.map((f) => f.tier), ['primary', 'unknown', 'unknown']);
  assert.deepEqual(dossier.facts.map((f) => f.date), ['2026', null, null]);
});

test('a date only survives when the source actually gave one', () => {
  assert.equal(normaliseDate('2026-09-01'), '2026-09-01');
  assert.equal(normaliseDate('2026-09'), '2026-09');
  assert.equal(normaliseDate('2026'), '2026');
  assert.equal(normaliseDate('2026-09-01T00:00:00Z'), '2026-09-01');
  assert.equal(normaliseDate('recently'), null);
  assert.equal(normaliseDate('2026-13'), null);
  assert.equal(normaliseDate('1899'), null);
  assert.equal(normaliseDate(''), null);
  assert.equal(normaliseDate(undefined), null);
});

test('prices are coerced to numbers and an unusable one is dropped', () => {
  const dossier = normaliseDossier({
    priceObservations: [
      { product: 'p', value: 'A$1,149.00', currency: 'aud', retailer: 'JB Hi-Fi', dateChecked: '2026-09-01' },
      { product: 'p', value: 999, currency: '', retailer: 'Amazon AU', dateChecked: 'last week' },
      { product: 'p', value: 'call for price', retailer: 'Bing Lee', dateChecked: '2026-09-01' },
      { product: 'p', value: 500, currency: 'AUD', retailer: '', dateChecked: '2026-09-01' },
    ],
  });

  assert.equal(dossier.priceObservations.length, 2);
  assert.deepEqual(dossier.priceObservations[0], {
    product: 'p', value: 1149, currency: 'AUD', retailer: 'JB Hi-Fi',
    dateChecked: '2026-09-01', sourceUrl: '',
  });
  assert.equal(dossier.priceObservations[1].currency, 'unknown');
  assert.equal(dossier.priceObservations[1].dateChecked, null);
});

test('complaint volume and tested-claim years are validated, not trusted', () => {
  const dossier = normaliseDossier({
    ownerComplaints: [
      { product: 'p', complaint: 'dies at 9 minutes', volume: 'Widespread', recency: '2026-03' },
      { product: 'p', complaint: 'noisy', volume: 'a lot', recency: 'ages ago' },
      { product: 'p', complaint: '   ' },
    ],
    testedClaims: [
      { claim: '84 dB measured', source: 'Choice', year: '2025' },
      { claim: 'runs 60 min', source: 'Canstar Blue', year: 'last year' },
      { claim: 'unattributed', year: 2026 },
    ],
  });

  assert.deepEqual(dossier.ownerComplaints.map((c) => c.volume), ['widespread', 'unknown']);
  assert.deepEqual(dossier.ownerComplaints.map((c) => c.recency), ['2026-03', null]);
  assert.deepEqual(dossier.testedClaims.map((t) => t.year), [2025, null]);
});

test('missing strata become empty arrays rather than undefined holes', () => {
  const dossier = normaliseDossier({ summary: 'x', keywords: { primary: 'k' } });

  assert.deepEqual(dossier.failureModes, []);
  assert.deepEqual(dossier.whoShouldNotBuy, []);
  assert.deepEqual(dossier.ownerComplaints, []);
  assert.deepEqual(dossier.priceObservations, []);
  assert.deepEqual(dossier.testedClaims, []);
  assert.deepEqual(dossier.keywords, { primary: 'k', secondary: [] });
  assert.equal(dossier.competitorNotes, '');
});

// The behaviour these two protect predates the strata and must not change:
// a bad amazonUrl is money, and a bad goSlug is a 404 in the affiliate table.

test('a non-Amazon URL is dropped with a note, exactly as before', () => {
  const dossier = normaliseDossier({
    products: [
      { name: 'Dyson V15', brand: 'Dyson', approxPrice: '', goSlug: 'dyson-v15',
        amazonUrl: 'https://thegoodguys.com.au/dyson-v15', notes: 'strong pick' },
      { name: 'Shark Detect Pro', brand: 'Shark', approxPrice: '', goSlug: 'shark-detect-pro',
        amazonUrl: 'https://www.amazon.com.au/dp/B0CJ1234AB', notes: '' },
    ],
  });

  assert.equal(dossier.products[0].amazonUrl, null);
  assert.equal(
    dossier.products[0].notes,
    'strong pick [non-Amazon URL dropped: https://thegoodguys.com.au/dyson-v15]',
  );
  assert.equal(dossier.products[1].amazonUrl, 'https://www.amazon.com.au/dp/B0CJ1234AB');
  assert.equal(dossier.products[1].notes, '');
});

test('goSlug is normalised, falling back to the product name', () => {
  const dossier = normaliseDossier({
    products: [
      { name: "Sony WH-1000XM6", brand: 'Sony', approxPrice: '', goSlug: 'Sony WH_1000XM6!', amazonUrl: null, notes: '' },
      { name: "Dyson's V15 Detect", brand: 'Dyson', approxPrice: '', goSlug: '', amazonUrl: null, notes: '' },
    ],
  });

  assert.deepEqual(dossier.products.map((p) => p.goSlug), ['sony-wh-1000xm6', 'dysons-v15-detect']);
});

test('facts from a pre-tiering dossier count as untiered, not as a stratum', () => {
  const legacy = {
    ...sufficientGuide(),
    facts: [
      { fact: 'Announced 22 July 2026', sourceUrl: 'https://news.samsung.com/au/x' },
      { fact: 'Three models in the lineup', sourceUrl: 'https://samsung.com/au/y' },
    ],
  };
  const counts = countEvidence(legacy as unknown as ResearchDossier);
  assert.equal(counts.untieredFacts, 2);
  assert.equal(counts.primaryFacts, 0);
  assert.equal(counts.datedFacts, 0);
});
