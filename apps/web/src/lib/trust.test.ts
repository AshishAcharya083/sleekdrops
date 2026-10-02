/**
 * The shared trust vocabulary: what a score is called, what a breakdown has
 * to add up to, and which badges may be printed, for how long, and how many.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessmentProvenance,
  assessmentProvenances,
  badgeClaimText,
  badgeInWindow,
  badgeKinds,
  badgeProblems,
  badgeProofHref,
  badgeRegistry,
  capBadged,
  CURRENT_METHOD_VERSION,
  displayableBadge,
  methodLabel,
  methodVersions,
  productCalloutLabel,
  provenanceLabel,
  scoreBand,
  scoreBands,
  subScoreProblems,
  weightedScore,
  type BadgeClaim,
} from './trust.ts';

// Midday in Sydney on 2 October 2026.
const BUILD = new Date('2026-10-02T02:00:00Z');

const scoreBadge = (overrides: Partial<Extract<BadgeClaim, { kind: 'review-score' }>> = {}): BadgeClaim => ({
  kind: 'review-score',
  evidence: { score: 4.4, reviewSlug: 'sony-wh-1000xm6-review' },
  checkedAt: '2026-09-20',
  ...overrides,
});

const skipBadge: BadgeClaim = {
  kind: 'skip-for-now',
  evidence: { reason: 'it was A$60 cheaper in July', sourceUrl: 'https://www.jbhifi.com.au/products/x' },
  checkedAt: '2026-10-01',
};

const lowestBadge: BadgeClaim = {
  kind: 'lowest-price',
  evidence: {
    price: 'A$349',
    previousLowest: 'A$379',
    observations: 12,
    sourceUrl: 'https://www.jbhifi.com.au/products/x',
  },
  checkedAt: '2026-10-02',
};

test('each band starts exactly on its boundary and stops just below the next', () => {
  assert.equal(scoreBand(5).label, 'Excellent');
  assert.equal(scoreBand(4.5).label, 'Excellent');
  assert.equal(scoreBand(4.4).label, 'Strong');
  assert.equal(scoreBand(4.0).label, 'Strong');
  assert.equal(scoreBand(3.9).label, 'Decent');
  assert.equal(scoreBand(3.5).label, 'Decent');
  assert.equal(scoreBand(3.4).label, 'Mixed');
  assert.equal(scoreBand(3.0).label, 'Mixed');
  assert.equal(scoreBand(2.9).label, 'Weak');
  assert.equal(scoreBand(1).label, 'Weak');
});

test('a score is banded as it is printed, so the word never contradicts the number', () => {
  // 4.46 prints as "4.5"; calling it Strong would sit beside the Excellent number.
  assert.equal((4.46).toFixed(1), '4.5');
  assert.equal(scoreBand(4.46).label, 'Excellent');
  assert.equal(scoreBand(4.44).label, 'Strong');
});

test('a score off the 1-5 scale is refused rather than banded', () => {
  for (const score of [0.9, 5.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scoreBand(score), RangeError);
  }
});

test('every band is one word with a plain-language meaning, highest first', () => {
  for (const band of scoreBands) {
    assert.match(band.label, /^[A-Z][a-z]+$/);
    assert.ok(band.meaning.length > 10);
  }
  const mins = scoreBands.map((band) => band.min);
  assert.deepEqual(mins, [...mins].sort((a, b) => b - a));
  assert.equal(mins.at(-1), 1);
});

test('the current method is the latest published version, labelled for readers', () => {
  assert.equal(CURRENT_METHOD_VERSION, methodVersions.at(-1)?.version);
  assert.equal(methodLabel('1.0'), 'Method v1.0');
  for (const entry of methodVersions) assert.match(entry.effective, /^\d{4}-\d{2}-\d{2}$/);
});

test('provenance has exactly the three ways a product can be assessed', () => {
  assert.deepEqual([...assessmentProvenances], ['retail', 'loan', 'none']);
  assert.equal(provenanceLabel('retail'), 'Bought at retail by us');
  assert.equal(provenanceLabel('loan'), 'Sample supplied by the brand and returned');
  assert.equal(provenanceLabel('none'), 'Not hands-on: assessed from published specs and owner reports');
});

test('a review that records no provenance falls back to the honest one', () => {
  assert.equal(assessmentProvenance(undefined), 'none');
  assert.equal(assessmentProvenance({}), 'none');
  assert.equal(assessmentProvenance({}, { acquisition: 'loan' }), 'loan');
  assert.equal(assessmentProvenance({ provenance: 'retail' }, { acquisition: 'retail' }), 'retail');
});

test('a breakdown whose weighted sum is the headline score passes', () => {
  const subScores = [
    { label: 'Value', score: 4.5, weight: 0.4 },
    { label: 'Build', score: 4.0, weight: 0.3 },
    { label: 'Battery', score: 4.6, weight: 0.3 },
  ];
  assert.equal(Number(weightedScore(subScores).toFixed(2)), 4.38);
  assert.deepEqual(subScoreProblems(4.4, subScores), []);
});

test('a breakdown is allowed half a printed decimal of drift and no more', () => {
  const subScores = (top: number) => [
    { label: 'A', score: top, weight: 0.5 },
    { label: 'B', score: 4.0, weight: 0.5 },
  ];
  // Recomputes to 4.35 and 4.45: exactly on the tolerance either side of 4.4.
  assert.deepEqual(subScoreProblems(4.4, subScores(4.7)), []);
  assert.deepEqual(subScoreProblems(4.4, subScores(4.9)), []);
  // 4.5 is a tenth away - the headline would be printing a different number.
  assert.equal(subScoreProblems(4.4, subScores(5.0)).length, 1);
  assert.match(subScoreProblems(4.4, subScores(5.0))[0], /recompute to 4\.50/);
});

test('weights that do not sum to one are refused before anything is recomputed', () => {
  const problems = subScoreProblems(4.0, [
    { label: 'A', score: 4.0, weight: 0.5 },
    { label: 'B', score: 4.0, weight: 0.4 },
  ]);
  assert.deepEqual(problems, ['sub-score weights sum to 0.900, not 1']);
});

test('the registry holds only checkable statements: no urgency, scarcity, countdown or endorsement', () => {
  assert.deepEqual([...badgeKinds].sort(), Object.keys(badgeRegistry).sort());
  const banned = /hurry|limited|only \d|left|ends|ending|countdown|today only|selling fast|editor|choice|best|top pick|recommended|award|guarantee/i;
  for (const kind of badgeKinds) {
    const definition = badgeRegistry[kind];
    assert.doesNotMatch(kind, banned, kind);
    assert.doesNotMatch(definition.claimTemplate, banned, definition.claimTemplate);
    assert.ok(definition.checkDate.length > 0, `${kind} says what its check date records`);
    assert.ok(definition.validForDays > 0, `${kind} has a window`);
  }
});

test('price-history kinds are defined but off; the score and honest-negative kinds are on', () => {
  assert.equal(badgeRegistry['lowest-price'].family, 'price-history');
  assert.equal(badgeRegistry['lowest-price'].enabled, false);
  assert.equal(badgeRegistry['below-average'].family, 'price-history');
  assert.equal(badgeRegistry['below-average'].enabled, false);
  assert.equal(badgeRegistry['review-score'].enabled, true);
  assert.equal(badgeRegistry['skip-for-now'].family, 'honest-negative');
  assert.equal(badgeRegistry['skip-for-now'].enabled, true);
});

test('each badge prints its claim from its evidence and links its proof', () => {
  assert.equal(badgeClaimText(scoreBadge()), '4.4/5 in our review');
  assert.equal(badgeClaimText(scoreBadge({ evidence: { score: 4, reviewSlug: 'x' } })), '4.0/5 in our review');
  assert.equal(badgeClaimText(skipBadge), 'Skip for now: it was A$60 cheaper in July');
  assert.equal(badgeClaimText(lowestBadge), 'Lowest price in 90 days');
  assert.equal(
    badgeClaimText({
      kind: 'below-average',
      evidence: { price: 'A$349', average: 'A$390', below: '$41', observations: 30, sourceUrl: 'https://x.com/' },
      checkedAt: '2026-10-02',
    }),
    '$41 below its 30-day average',
  );

  assert.equal(badgeRegistry['review-score'].proof, 'review');
  assert.equal(badgeProofHref(scoreBadge()), '/blog/sony-wh-1000xm6-review');
  assert.equal(badgeRegistry['skip-for-now'].proof, 'source');
  assert.equal(badgeProofHref(skipBadge), 'https://www.jbhifi.com.au/products/x');
});

test('a badge cannot be entered without its evidence or its check date', () => {
  assert.deepEqual(badgeProblems(scoreBadge()), []);
  assert.deepEqual(badgeProblems(skipBadge), []);

  const { checkedAt: _dropped, ...undated } = scoreBadge();
  assert.notDeepEqual(badgeProblems(undated), []);
  assert.notDeepEqual(badgeProblems({ kind: 'review-score', checkedAt: '2026-09-20' }), []);
  assert.notDeepEqual(badgeProblems({ ...skipBadge, evidence: { reason: 'cheaper in July' } }), []);
  assert.notDeepEqual(badgeProblems({ ...skipBadge, evidence: { ...skipBadge.evidence, sourceUrl: 'javascript:alert(1)' } }), []);
  assert.notDeepEqual(badgeProblems({ kind: 'editors-choice', evidence: {}, checkedAt: '2026-09-20' }), []);
  assert.notDeepEqual(badgeProblems({ ...scoreBadge(), checkedAt: '20 Sept 2026' }), []);
  assert.notDeepEqual(badgeProblems({ ...scoreBadge(), checkedAt: '2026-02-30' }), []);
  assert.notDeepEqual(badgeProblems({ ...scoreBadge(), checkedAt: '2026-13-01' }), []);
});

test('a well-formed price-history badge is still refused while its kind is off', () => {
  assert.deepEqual(badgeProblems(lowestBadge), [
    'badge kind "lowest-price" is switched off until the data behind it is collected',
  ]);
  assert.equal(displayableBadge(lowestBadge, BUILD), null);
});

test('a badge stands from its check date to the end of its window, and not after', () => {
  // review-score stands for the 365-day review interval.
  assert.equal(badgeInWindow(scoreBadge({ checkedAt: '2026-10-02' }), BUILD), true);
  assert.equal(badgeInWindow(scoreBadge({ checkedAt: '2025-10-02' }), BUILD), true);
  assert.equal(badgeInWindow(scoreBadge({ checkedAt: '2025-10-01' }), BUILD), false);
  // skip-for-now stands for 14 days.
  assert.equal(badgeInWindow({ ...skipBadge, checkedAt: '2026-09-18' }, BUILD), true);
  assert.equal(badgeInWindow({ ...skipBadge, checkedAt: '2026-09-17' }, BUILD), false);
  // A check dated after the build has not happened yet.
  assert.equal(badgeInWindow(scoreBadge({ checkedAt: '2026-10-03' }), BUILD), false);
  assert.equal(displayableBadge(scoreBadge({ checkedAt: '2025-01-01' }), BUILD), null);
});

test("a check dated today in Sydney stands on a UTC build that is still on yesterday", () => {
  // 20:00 UTC on 1 October is 06:00 on 2 October in Sydney.
  const earlyMorningInSydney = new Date('2026-10-01T20:00:00Z');
  assert.equal(badgeInWindow(scoreBadge({ checkedAt: '2026-10-02' }), earlyMorningInSydney), true);
});

test('the cap keeps badges on the first printable items and the rest of the list intact', () => {
  const items = [
    { id: 'a', badge: scoreBadge() },
    { id: 'b', badge: lowestBadge },
    { id: 'c', badge: undefined },
    { id: 'd', badge: skipBadge },
    { id: 'e', badge: scoreBadge() },
    { id: 'f', badge: scoreBadge() },
  ];
  const capped = capBadged(items, (item) => item.badge, 2, BUILD);

  assert.deepEqual(
    capped.map(({ item }) => item.id),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
  // The disabled price badge neither prints nor uses up a slot.
  assert.deepEqual(
    capped.map(({ badge }) => badge?.kind ?? null),
    ['review-score', null, null, 'skip-for-now', null, null],
  );
});

test('the cap defaults to three per list', () => {
  const items = Array.from({ length: 6 }, () => scoreBadge());
  const capped = capBadged(items, (badge) => badge, undefined, BUILD);
  assert.equal(capped.filter(({ badge }) => badge !== null).length, 3);
});

test("a product callout never falls back to an endorsement", () => {
  const postSlug = 'sony-wh-1000xm6-review';
  // A legacy free-text badge carries no evidence and is not printed.
  assert.deepEqual(productCalloutLabel({ badge: "Editor's choice", kind: 'Review', postSlug }, BUILD), {
    text: 'Review',
  });
  assert.equal(productCalloutLabel({ badge: 'Best value', postSlug }, BUILD), null);
  assert.equal(productCalloutLabel({ postSlug }, BUILD), null);
  // The review's own score badge needs no link to the page it is on.
  assert.deepEqual(productCalloutLabel({ badge: scoreBadge(), kind: 'Review', postSlug }, BUILD), {
    text: '4.4/5 in our review',
  });
  assert.deepEqual(productCalloutLabel({ badge: skipBadge, postSlug }, BUILD), {
    text: 'Skip for now: it was A$60 cheaper in July',
    href: 'https://www.jbhifi.com.au/products/x',
  });
  // A lapsed badge gives way to the kind rather than printing a stale claim.
  assert.deepEqual(
    productCalloutLabel({ badge: { ...skipBadge, checkedAt: '2026-01-01' }, kind: 'Review', postSlug }, BUILD),
    { text: 'Review' },
  );
  assert.deepEqual(productCalloutLabel({ badge: scoreBadge(), eyebrow: 'In this guide', postSlug }, BUILD), {
    text: 'In this guide',
  });
});
