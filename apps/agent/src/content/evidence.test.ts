// The deterministic half of the research stage. No model, no Tavily: the
// point of moving normalisation and the sufficiency bar out of the prompt is
// that both are now checkable the same way twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEvidenceSufficient,
  barFor,
  checkEvidence,
  countEvidence,
  describeBar,
  EvidenceGateError,
  normaliseDate,
  normaliseDossier,
} from './evidence.js';
import type { ResearchDossier } from '../pipeline/types.js';

/** A guide dossier that clears every stratum, used as the baseline to break. */
function sufficientGuide(): ResearchDossier {
  const fact = (n: number, tier: 'primary' | 'expert' | 'owner') => ({
    fact: `${tier} fact ${n}`,
    sourceUrl: `https://example.com/${tier}/${n}`,
    tier,
    date: '2026-04-01',
    publisher: 'Choice',
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
      audience: `anyone vacuuming a three-storey townhouse ${n}`,
      reason: 'the run time does not cover a three-bedroom house',
      sourceUrl: `https://productreview.com.au/w/${n}`,
    })),
    ownerComplaints: [1, 2, 3, 4].map((n) => ({
      product: 'Dyson V15 Detect',
      complaint: `battery drops to nine minutes ${n}`,
      volume: 'recurring' as const,
      recency: '2026-03',
      denominator: `${n}7 of 412 ProductReview reviews`,
      kind: 'quoted' as const,
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
  assert.ok(short.some((l) => l.includes('buyer exclusions')));
  // Actionable, not just a verdict: it names where each thin stratum lives.
  assert.match(verdict.message, /owner complaints with a named source and a denominator 0\/4/);
  assert.match(verdict.message, /productreview\.com\.au/i);
  assert.match(verdict.message, /- price:/);
});

test('every shortfall carries have, need and where to gather it', () => {
  const verdict = checkEvidence({ ...sufficientGuide(), ownerComplaints: [] }, 'guide');
  const complaints = verdict.shortfalls.find((s) => s.stratum === 'owner');

  assert.ok(complaints);
  assert.equal(complaints.have, 0);
  assert.equal(complaints.need, barFor('guide').attributedOwnerComplaints);
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

// ── What makes a complaint and an exclusion count ───────────────────────────
// The counts are the whole point of the gate, so what they will and will not
// accept is the behaviour worth pinning. Four hand-picked quotes with nothing
// behind them is the anecdote-mining a no-sponsored-posts site cannot afford.

test('a complaint with no denominator is not evidence of anything', () => {
  const unattributed: ResearchDossier = {
    ...sufficientGuide(),
    ownerComplaints: sufficientGuide().ownerComplaints.map((c) => ({ ...c, denominator: null })),
  };
  const verdict = checkEvidence(unattributed, 'guide');

  assert.equal(verdict.counts.ownerComplaints, 4);
  assert.equal(verdict.counts.attributedOwnerComplaints, 0);
  assert.equal(verdict.pass, false);
});

test('a complaint nobody can open is not evidence either', () => {
  const unsourced: ResearchDossier = {
    ...sufficientGuide(),
    ownerComplaints: sufficientGuide().ownerComplaints.map((c) => ({ ...c, sourceUrl: 'reddit' })),
  };
  assert.equal(countEvidence(unsourced).attributedOwnerComplaints, 0);
});

test('one published fault rate stands in for the four quoted complaints', () => {
  // How Choice actually reports ownership: 9% of 1,076 owners, field window
  // published. That is better evidence than four quotes, not worse.
  const aggregate: ResearchDossier = {
    ...sufficientGuide(),
    ownerComplaints: [
      {
        product: 'Dyson V15 Detect',
        complaint: 'stops mid-clean',
        volume: 'recurring',
        recency: '2026-03',
        denominator: '9% of 1,076 owners surveyed',
        kind: 'aggregate',
        sourceUrl: 'https://choice.com.au/reliability',
      },
    ],
  };
  const verdict = checkEvidence(aggregate, 'guide');

  assert.equal(verdict.counts.attributedOwnerComplaints, 1);
  assert.equal(verdict.counts.aggregateFaultRates, 1);
  assert.equal(verdict.pass, true, verdict.message);
});

test('an aggregate with no field window does not substitute', () => {
  const undated: ResearchDossier = {
    ...sufficientGuide(),
    ownerComplaints: [
      {
        product: 'Dyson V15 Detect',
        complaint: 'stops mid-clean',
        volume: 'recurring',
        recency: null,
        denominator: '9% of owners surveyed',
        kind: 'aggregate',
        sourceUrl: 'https://choice.com.au/reliability',
      },
    ],
  };
  const verdict = checkEvidence(undated, 'guide');

  assert.equal(verdict.counts.aggregateFaultRates, 0);
  assert.equal(verdict.pass, false);
});

test('exclusions that route nobody are dropped rather than counted', () => {
  // The bar is one, so a padded second exclusion buys nothing - and a quota
  // met with "not for everyone" is a claim about the product nobody checked.
  const padded: ResearchDossier = {
    ...sufficientGuide(),
    whoShouldNotBuy: [
      { audience: 'not for everyone', reason: 'it will not suit every single household out there', sourceUrl: 'https://x.test/a' },
      { audience: 'beginners', reason: 'this one is a bit much for a first-time buyer', sourceUrl: 'https://x.test/b' },
      { audience: 'anyone on a tight budget', reason: 'there are cheaper machines available elsewhere', sourceUrl: 'https://x.test/c' },
      { audience: 'renters with no storage', reason: 'expensive', sourceUrl: 'https://x.test/d' },
      { audience: 'renters with no storage', reason: 'the dock needs 40cm of wall and cannot be freestanding', sourceUrl: '' },
    ],
  };
  const counts = countEvidence(padded);

  assert.equal(counts.whoShouldNotBuy, 5);
  assert.equal(counts.groundedExclusions, 0);
  assert.equal(checkEvidence(padded, 'guide').pass, false);
});

test('one real exclusion clears the bar - a second is never forced', () => {
  const one: ResearchDossier = {
    ...sufficientGuide(),
    whoShouldNotBuy: [sufficientGuide().whoShouldNotBuy[0]],
  };
  assert.equal(barFor('guide').groundedExclusions, 1);
  assert.equal(checkEvidence(one, 'guide').pass, true);
});

test('a category with no Australian owner corpus keeps a floor, not the full set', () => {
  // Health has no ProductReview depth and no member survey behind it. Holding
  // a supplements guide to the vacuum bar produces invented owners, not real
  // ones - so the floor drops and the piece has to disclose the small sample.
  const oneComplaint: ResearchDossier = {
    ...sufficientGuide(),
    failureModes: sufficientGuide().failureModes.slice(0, 1),
    ownerComplaints: sufficientGuide().ownerComplaints.slice(0, 1),
    facts: [
      ...sufficientGuide().facts.filter((f) => f.tier !== 'owner'),
      sufficientGuide().facts.find((f) => f.tier === 'owner')!,
    ],
  };

  assert.equal(checkEvidence(oneComplaint, 'guide', 'Health').pass, true);
  assert.equal(checkEvidence(oneComplaint, 'guide', 'Home').pass, false);
  // The floor is a floor, not an exemption: nothing at all still fails.
  assert.equal(
    checkEvidence({ ...oneComplaint, ownerComplaints: [] }, 'guide', 'Health').pass,
    false,
  );
});

test('the prompt is told the same numbers the gate enforces', () => {
  // Printed from EVIDENCE_BAR, never written out beside it: a stage that fails
  // a count nobody mentioned fails twice for the same reason.
  const guide = describeBar('guide', 'Home');
  assert.match(guide, /A guide in Home needs at least/);
  assert.match(guide, new RegExp(`failure modes \\(${barFor('guide').failureModes}\\)`));
  assert.match(
    guide,
    new RegExp(`denominator \\(${barFor('guide').attributedOwnerComplaints}\\)`),
  );

  // And the eased ones, where the bar itself is different.
  const health = describeBar('guide', 'Health');
  assert.match(health, /failure modes \(1\)/);
  // Nothing the bar does not ask for is listed as a requirement.
  assert.doesNotMatch(describeBar('article'), /failure modes/);
});

// ── The fail path ───────────────────────────────────────────────────────────

test('a thin dossier throws the gate error, carrying the verdict', () => {
  const thin = { ...sufficientGuide(), ownerComplaints: [], failureModes: [] };
  assert.throws(
    () => assertEvidenceSufficient(thin, 'guide'),
    (err: unknown) => {
      assert.ok(err instanceof EvidenceGateError);
      assert.equal(err.sufficiency.pass, false);
      assert.match(err.message, /Evidence is too thin to write a guide from/);
      assert.match(err.message, /failure modes 0\/3/);
      return true;
    },
  );
  // Stamped even on the failure, so nothing has to recompute it to explain it.
  assert.equal(thin.sufficiency?.pass, false);
});

test('a sufficient dossier comes back stamped with what it passed on', () => {
  const dossier = assertEvidenceSufficient(sufficientGuide(), 'guide');
  assert.equal(dossier.sufficiency?.pass, true);
  assert.equal(dossier.sufficiency?.counts.attributedOwnerComplaints, 4);
  assert.match(dossier.sufficiency?.checkedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

// ── Dossier normalisation ───────────────────────────────────────────────────

test('an unrecognised tier is marked unknown, never promoted', () => {
  const dossier = normaliseDossier({
    facts: [
      { fact: 'a', sourceUrl: 'https://x/a', tier: 'PRIMARY', date: '2026', publisher: 'Sony' },
      { fact: 'b', sourceUrl: 'https://x/b', tier: 'manufacturer' },
      { fact: 'c', sourceUrl: 'https://x/c' },
    ],
  });

  assert.deepEqual(dossier.facts.map((f) => f.tier), ['primary', 'unknown', 'unknown']);
  assert.deepEqual(dossier.facts.map((f) => f.date), ['2026', null, null]);
  assert.deepEqual(dossier.facts.map((f) => f.publisher), ['Sony', null, null]);
});

test('a date only survives when the source actually gave one', () => {
  assert.equal(normaliseDate('2026-09-01'), '2026-09-01');
  assert.equal(normaliseDate('2026-09'), '2026-09');
  assert.equal(normaliseDate('2026'), '2026');
  assert.equal(normaliseDate('2026-09-01T00:00:00Z'), '2026-09-01');
  // Unpadded is a formatting slip, not a missing date - pad it rather than
  // throwing away evidence the source actually carried.
  assert.equal(normaliseDate('2026-9-1'), '2026-09-01');
  assert.equal(normaliseDate('2026-9'), '2026-09');
  assert.equal(normaliseDate('recently'), null);
  assert.equal(normaliseDate('2026-09-32'), null);
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

test('a price range reads as its low end, never as its digits concatenated', () => {
  // "$1,299 - $1,499" stripped of punctuation is 12,991,499: a real number,
  // dated and attributed, and nonsense in front of a reader.
  const dossier = normaliseDossier({
    priceObservations: [
      { product: 'p', value: '$1,299 - $1,499', currency: 'AUD', retailer: 'JB Hi-Fi', dateChecked: '2026-09-01' },
      { product: 'p', value: 'from A$1,149.00 at The Good Guys', currency: 'AUD', retailer: 'The Good Guys', dateChecked: '2026-9-1' },
    ],
  });

  assert.deepEqual(
    dossier.priceObservations.map((o) => [o.value, o.dateChecked]),
    [[1299, '2026-09-01'], [1149, '2026-09-01']],
  );
});

test('complaint volume and tested-claim years are validated, not trusted', () => {
  const dossier = normaliseDossier({
    ownerComplaints: [
      { product: 'p', complaint: 'dies at 9 minutes', volume: 'Widespread', recency: '2026-03',
        denominator: '37 of 412 reviews', kind: 'Aggregate' },
      { product: 'p', complaint: 'noisy', volume: 'a lot', recency: 'ages ago', kind: 'hearsay' },
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
  // An unrecognised kind is 'quoted': the substitution rule only fires on a
  // complaint that explicitly claims to be an aggregate.
  assert.deepEqual(dossier.ownerComplaints.map((c) => c.kind), ['aggregate', 'quoted']);
  assert.deepEqual(dossier.ownerComplaints.map((c) => c.denominator), ['37 of 412 reviews', null]);
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
