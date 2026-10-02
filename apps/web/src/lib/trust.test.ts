/**
 * The shared trust vocabulary: what a score is called, what a breakdown has
 * to add up to, and which badges may be printed, for how long, and how many.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dailyDeals } from '../data/deals.ts';
import {
  assessmentProvenance,
  BADGE_KINDS,
  BADGE_REGISTRY,
  badgeAllowance,
  badgeClaim,
  badgeProblems,
  capBadged,
  CURRENT_METHOD_VERSION,
  formatCheckDay,
  isBadgeLive,
  MAX_BADGED_PER_LISTING,
  methodLabel,
  METHOD_VERSIONS,
  productBadgeClaim,
  productBadgeKind,
  productBadgeProblems,
  PROVENANCE_COPY,
  PROVENANCES,
  SCORE_BANDS,
  scoreBand,
  SUB_SCORE_TOLERANCE,
  subScoreProblems,
  weightedScore,
  type DealBadge,
} from './trust.ts';

// Midday in Sydney on 2 October 2026.
const BUILD = new Date('2026-10-02T02:00:00Z');

const scoreBadge: DealBadge = {
  kind: 'review-score',
  evidence: { reviewSlug: 'sony-wh-1000xm6-review', rating: 4.4 },
  checkedAt: '2026-09-20',
};

const skipBadge: DealBadge = {
  kind: 'honest-negative',
  evidence: { note: 'Likely cheaper at Black Friday (27 Nov).' },
  checkedAt: '2026-10-02',
};

const daysAfter = (day: string, days: number) => new Date(Date.parse(`${day}T02:00:00Z`) + days * 86_400_000);

const disabledKinds = BADGE_KINDS.filter((kind) => !BADGE_REGISTRY[kind].enabled);

/** A well-formed badge of any kind, so a disabled kind is refused for being off rather than malformed. */
function sampleBadge(kind: (typeof BADGE_KINDS)[number]): DealBadge {
  switch (kind) {
    case 'review-score':
      return scoreBadge;
    case 'honest-negative':
      return skipBadge;
    case 'lowest-price':
      return { kind, evidence: { price: 'A$449', previousLowest: 'A$479', observations: 12 }, checkedAt: '2026-10-02' };
    case 'below-average':
      return {
        kind,
        evidence: { price: 'A$449', average: 'A$490', below: 'A$41', observations: 12 },
        checkedAt: '2026-10-02',
      };
  }
}

// --- Score bands -------------------------------------------------------------

test('every band boundary belongs to the band it opens', () => {
  const cases: Array<[number, string]> = [
    [5, 'Excellent'],
    [4.5, 'Excellent'],
    [4.4, 'Strong'],
    [4.0, 'Strong'],
    [3.9, 'Decent'],
    [3.5, 'Decent'],
    [3.4, 'Mixed'],
    [3.0, 'Mixed'],
    [2.9, 'Weak'],
    [1, 'Weak'],
  ];
  for (const [rating, label] of cases) assert.equal(scoreBand(rating).label, label, `${rating}`);
});

test('a score is banded as it is printed, so the number and the word never disagree', () => {
  assert.equal(scoreBand(4.46).id, 'excellent');
  assert.equal(scoreBand(4.44).id, 'strong');
  assert.equal(scoreBand(3.95).id, 'strong');
});

test('the bands run high to low, cover the whole scale and each carry one word', () => {
  for (let i = 1; i < SCORE_BANDS.length; i += 1) assert.ok(SCORE_BANDS[i - 1].min > SCORE_BANDS[i].min);
  assert.equal(SCORE_BANDS[SCORE_BANDS.length - 1].min, 1);
  for (const band of SCORE_BANDS) {
    assert.match(band.label, /^[A-Z][a-z]+$/, band.id);
    assert.ok(band.meaning.length > 0, band.id);
  }
  for (let tenths = 10; tenths <= 50; tenths += 1) assert.doesNotThrow(() => scoreBand(tenths / 10));
});

test('a score outside the scale is clamped rather than thrown on', () => {
  assert.equal(scoreBand(5.4).id, 'excellent');
  assert.equal(scoreBand(0).id, 'weak');
  assert.equal(scoreBand(Number.NaN).id, 'weak');
});

test('no band meaning is a superlative the site average would contradict', () => {
  for (const band of SCORE_BANDS) assert.doesNotMatch(band.meaning, /\bbest\b|ever|world/i, band.id);
});

// --- Method version and provenance -------------------------------------------

test('the current method version is the newest published one, oldest first', () => {
  assert.equal(CURRENT_METHOD_VERSION, METHOD_VERSIONS[METHOD_VERSIONS.length - 1].version);
  assert.ok(METHOD_VERSIONS.some((entry) => entry.version === '1.0'));
  const dates = METHOD_VERSIONS.map((entry) => entry.date);
  assert.deepEqual([...dates].sort(), dates);
  for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(methodLabel('1.0'), 'Method v1.0');
});

test('provenance has exactly the three plain options, and the fallback is not hands-on', () => {
  assert.deepEqual([...PROVENANCES], ['retail', 'brand-sample', 'not-hands-on']);
  assert.match(PROVENANCE_COPY.retail.statement, /bought .* at retail/i);
  assert.match(PROVENANCE_COPY['brand-sample'].statement, /supplied .* returned/i);
  assert.match(PROVENANCE_COPY['not-hands-on'].statement, /did not handle/);
  assert.match(PROVENANCE_COPY['not-hands-on'].statement, /published specs and owner reports/);
  assert.equal(assessmentProvenance(undefined), 'not-hands-on');
  assert.equal(assessmentProvenance({}, { acquisition: 'loan' }), 'brand-sample');
  assert.equal(assessmentProvenance({}, { acquisition: 'none' }), 'not-hands-on');
  assert.equal(assessmentProvenance({ provenance: 'retail' }, { acquisition: 'retail' }), 'retail');
});

// --- Sub-scores --------------------------------------------------------------

test('a breakdown whose weighted sum is the headline passes', () => {
  const subScores = [
    { label: 'Noise cancelling', score: 4.8, weight: 0.4 },
    { label: 'Comfort', score: 4.2, weight: 0.3 },
    { label: 'Value', score: 4.1, weight: 0.3 },
  ];
  assert.ok(Math.abs(weightedScore(subScores) - 4.41) < 1e-9);
  assert.deepEqual(subScoreProblems(4.4, subScores), []);
});

test('a breakdown exactly on the tolerance passes and one just past it fails', () => {
  const pair = (a: number, b: number) => [
    { label: 'A', score: a, weight: 0.5 },
    { label: 'B', score: b, weight: 0.5 },
  ];
  assert.equal(SUB_SCORE_TOLERANCE, 0.05);
  assert.deepEqual(subScoreProblems(4.0, pair(4.1, 4.0)), []);
  assert.match(subScoreProblems(4.0, pair(4.2, 4.0))[0], /recompute to 4\.10/);
});

test('a breakdown whose weights do not sum to 1 fails before any arithmetic is trusted', () => {
  const problems = subScoreProblems(4.0, [
    { label: 'A', score: 4, weight: 0.5 },
    { label: 'B', score: 4, weight: 0.4 },
  ]);
  assert.deepEqual(problems, ['sub-score weights sum to 0.900, not 1']);
});

// --- Badge registry ----------------------------------------------------------

test('every registry entry declares its claim, evidence, window, proof and switch', () => {
  for (const kind of BADGE_KINDS) {
    const entry = BADGE_REGISTRY[kind];
    assert.equal(entry.kind, kind);
    assert.ok(entry.label.length > 0, kind);
    assert.ok(entry.claimTemplate.length > 0, kind);
    assert.ok(entry.evidenceField.length > 0, kind);
    assert.ok(Number.isInteger(entry.windowDays) && entry.windowDays > 0, kind);
    assert.ok(entry.proof === 'review' || entry.proof === 'glossary', kind);
    assert.equal(typeof entry.enabled, 'boolean', kind);
    const evidence = sampleBadge(kind).evidence as Record<string, unknown>;
    assert.ok(entry.evidenceField in evidence, `${kind} evidenceField is a key of its evidence`);
  }
});

test('the score and honest-negative badges are on; price history is defined but off', () => {
  assert.equal(BADGE_REGISTRY['review-score'].enabled, true);
  assert.equal(BADGE_REGISTRY['review-score'].proof, 'review');
  assert.equal(BADGE_REGISTRY['honest-negative'].enabled, true);
  assert.ok(disabledKinds.length > 0);
  for (const kind of disabledKinds) assert.equal(BADGE_REGISTRY[kind].proof, 'glossary', kind);
});

test('the registry holds no urgency, scarcity, countdown or endorsement kind', () => {
  const banned = /hurry|limited|only \d|left|ends|countdown|today only|editor|choice|best|recommended|pick|award/i;
  for (const kind of BADGE_KINDS) {
    const { label, claimTemplate } = BADGE_REGISTRY[kind];
    assert.doesNotMatch(`${kind} ${label} ${claimTemplate}`, banned, kind);
  }
});

test('an honest-negative badge lives at most 14 days and always prints its check date', () => {
  assert.ok(BADGE_REGISTRY['honest-negative'].windowDays <= 14);
  assert.equal(badgeClaim(skipBadge), 'Skip for now - checked 2 Oct. Likely cheaper at Black Friday (27 Nov).');
  assert.equal(formatCheckDay('2026-01-09'), '9 Jan');
});

test('a badge claim fills its template from the evidence', () => {
  assert.equal(badgeClaim(scoreBadge), '4.4/5 in our review');
  assert.equal(badgeClaim({ ...scoreBadge, evidence: { reviewSlug: 'x', rating: 4 } }), '4.0/5 in our review');
  assert.equal(badgeClaim(sampleBadge('below-average')), 'A$41 below its 30-day average');
});

test('a live badge stays live through the last day of its window and lapses the day after', () => {
  const window = BADGE_REGISTRY['honest-negative'].windowDays;
  assert.equal(isBadgeLive(skipBadge, daysAfter(skipBadge.checkedAt, 0)), true);
  assert.equal(isBadgeLive(skipBadge, daysAfter(skipBadge.checkedAt, window)), true);
  assert.equal(isBadgeLive(skipBadge, daysAfter(skipBadge.checkedAt, window + 1)), false);
});

test('the window is counted in Sydney days, not the build server UTC day', () => {
  // 23:30 UTC on 1 October is already 2 October in Sydney.
  assert.equal(isBadgeLive(skipBadge, new Date('2026-10-01T23:30:00Z')), true);
  // Daylight saving has begun by then: 13:00 UTC on 16 October is midnight
  // on 17 October in Sydney, day 15, lapsed.
  assert.equal(isBadgeLive(skipBadge, new Date('2026-10-16T12:00:00Z')), true);
  assert.equal(isBadgeLive(skipBadge, new Date('2026-10-16T13:00:00Z')), false);
});

test('a check dated after the build has not happened yet', () => {
  assert.equal(isBadgeLive({ ...skipBadge, checkedAt: '2026-10-03' }, BUILD), false);
});

test('a badge missing or emptying its evidence is never live', () => {
  const broken = [
    { ...skipBadge, evidence: { note: '   ' } },
    { ...skipBadge, evidence: {} },
    { ...scoreBadge, evidence: { reviewSlug: '', rating: 4.4 } },
    { ...scoreBadge, evidence: { reviewSlug: 'sony-wh-1000xm6-review' } },
    { ...scoreBadge, checkedAt: '' },
    { ...scoreBadge, checkedAt: '2026-02-30' },
  ] as unknown as DealBadge[];
  for (const badge of broken) {
    assert.equal(isBadgeLive(badge, BUILD), false, JSON.stringify(badge));
    assert.ok(badgeProblems(badge).length > 0, JSON.stringify(badge));
  }
});

test('isBadgeLive never throws, whatever it is handed', () => {
  const junk = [undefined, null, 'review-score', { kind: 'editors-choice', evidence: {}, checkedAt: '2026-10-01' }];
  for (const badge of junk) assert.equal(isBadgeLive(badge as unknown as DealBadge, BUILD), false);
  assert.equal(isBadgeLive(scoreBadge, new Date('not a date')), false);
});

test('a disabled kind is never live, however well evidenced and fresh', () => {
  for (const kind of disabledKinds) {
    const badge = sampleBadge(kind);
    assert.equal(isBadgeLive(badge, daysAfter(badge.checkedAt, 0)), false, kind);
    assert.match(badgeProblems(badge).join(), /switched off/, kind);
  }
});

test('every deal badge is a registry badge that could print as entered', () => {
  // Deals are code-as-data, so this is where a malformed or switched-off badge
  // is caught before deploy rather than silently dropped from the card.
  for (const deal of dailyDeals) {
    if (deal.badge !== undefined) assert.deepEqual(badgeProblems(deal.badge), [], `deal "${deal.slug}"`);
  }
});

// --- Listing cap -------------------------------------------------------------

test('capBadged keeps the first badged items up to the cap, in list order', () => {
  const items = ['a', 'B', 'c', 'D', 'E', 'f', 'G', 'H'];
  const isBadged = (item: string) => item === item.toUpperCase();
  const { withinCap, overCap } = capBadged(items, isBadged);
  assert.equal(MAX_BADGED_PER_LISTING, 3);
  assert.deepEqual(withinCap, ['a', 'B', 'c', 'D', 'E', 'f']);
  assert.deepEqual(overCap, ['G', 'H']);
  assert.deepEqual(capBadged(items, isBadged, 1).overCap, ['D', 'E', 'G', 'H']);
  assert.deepEqual(capBadged(items, isBadged, 0).withinCap, ['a', 'c', 'f']);
});

test('capBadged leaves a listing under the cap alone and never throws', () => {
  assert.deepEqual(capBadged(['A', 'b'], (item) => item === 'A'), { withinCap: ['A', 'b'], overCap: [] });
  assert.deepEqual(capBadged([], () => true), { withinCap: [], overCap: [] });
  const throwing = capBadged([1, 2], () => {
    throw new Error('boom');
  });
  assert.deepEqual(throwing, { withinCap: [1, 2], overCap: [] });
});

test('the badge allowance is about one in five items, at least one, never past the ceiling', () => {
  const cases: Array<[number, number]> = [
    [1, 1],
    [9, 1],
    [10, 2],
    [14, 2],
    [15, 3],
    [60, 3],
  ];
  for (const [count, allowed] of cases) assert.equal(badgeAllowance(count), allowed, `${count} items`);
  assert.equal(badgeAllowance(60, 2), 2);
});

// --- Product (review) badges -------------------------------------------------

test('a legacy free-text product badge validates but names no registry kind and prints nothing', () => {
  for (const legacy of ["Editor's choice", 'Best value', 'Hurry - ends tonight']) {
    assert.deepEqual(productBadgeProblems(legacy), []);
    assert.equal(productBadgeKind(legacy), undefined);
    assert.equal(productBadgeClaim({ badge: legacy, rating: 4.4 }), undefined);
  }
  assert.equal(productBadgeClaim({ rating: 4.4 }), undefined);
});

test('a review-score product badge prints the review rating', () => {
  assert.equal(productBadgeKind('review-score'), 'review-score');
  assert.equal(productBadgeClaim({ badge: 'review-score', rating: 4.4 }), '4.4/5 in our review');
});

test('a product badge naming a kind a review cannot evidence, or a disabled kind, is refused', () => {
  assert.match(productBadgeProblems('honest-negative').join(), /belongs on a deal/);
  for (const kind of disabledKinds) assert.match(productBadgeProblems(kind).join(), /switched off/, kind);
});
