// finalizeReview is where a draft is actually cleared to publish, so it must
// hold without a live model: the deterministic voice scan has to be able to
// veto a model that liked the draft, the graded passes have to be able to fail
// it outright, and the merge must not lose the model's own issues while doing
// either.
//
// The three hard fails this file exists to pin down are the ones the old
// reviewer could not express at all: a specific the dossier does not carry, a
// piece that adds nothing to the results already ranking, and a draft that
// refuses to take a position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeReview,
  ISSUE_PREFIX,
  normaliseClaimAudit,
  normaliseDelta,
  normalisePosition,
  type ClaimAudit,
  type CompetitorDelta,
  type PositionCheck,
  type ReviewAudits,
} from './seoReviewer.js';
import { detectSlop } from '../content/slop.js';
import type { SeoReview } from '../pipeline/types.js';

const CLEAN = 'The Ninja AF160 costs $229 at Amazon Australia. It holds 5.7 litres.';
const SLOPPY = 'This robust solution seamlessly delves into the audio landscape.';

/**
 * A body long enough for the length-scaled rules to bite, with its sentence
 * lengths varied hard so the rhythm rule stays quiet. Used where a test needs
 * a real word count rather than a one-liner.
 */
const LONG_CLEAN = Array.from({ length: 12 }, (_, i) =>
  [
    'We tested it.',
    `The unit held its temperature within two degrees across four hours of continuous use in round ${i}, which is the number that decides whether a basket burns dinner or leaves it raw in the middle.`,
    'Owners report the same fault in month seven.',
  ].join(' '),
).join('\n\n');

/** A model verdict that would pass on its own. */
function verdict(overrides: Partial<SeoReview> = {}): SeoReview {
  return {
    score: 88,
    pass: true,
    issues: [],
    summary: 'Strong draft.',
    dimensions: { evidence: 90, position: 86, structure: 90, citability: 88, links: 92 },
    ...overrides,
  };
}

function delta(overrides: Partial<CompetitorDelta> = {}): CompetitorDelta {
  return {
    comparedWith: ['https://a.example/best', 'https://b.example/best'],
    additions: [
      {
        claim: 'The clutch fails after 14 months on the V11',
        absentFrom: 'https://a.example/best',
        evidence: 'ProductReview, 37 of 412 reviews',
      },
    ],
    duplicated: [],
    verdict: 'adds-substantially',
    notes: '',
    ...overrides,
  };
}

function claims(overrides: Partial<ClaimAudit> = {}): ClaimAudit {
  return {
    claims: [
      { claim: '$229', kind: 'price', supported: true, support: 'products[0].approxPrice' },
      { claim: '5.7 litres', kind: 'spec', supported: true, support: 'facts[2]' },
    ],
    notes: '',
    ...overrides,
  };
}

function position(overrides: Partial<PositionCheck> = {}): PositionCheck {
  return {
    takesStance: true,
    stance: 'The Dyson is the wrong buy above A$1,000.',
    recommendsEverythingEqually: false,
    picks: [{ pick: 'Dyson V15', cons: ['The battery is not user-replaceable'], hedged: false }],
    notes: '',
    ...overrides,
  };
}

/** All three passes clean - the baseline a passing draft has to clear. */
function passingAudits(overrides: Partial<ReviewAudits> = {}): ReviewAudits {
  return { competitors: delta(), claims: claims(), position: position(), ...overrides };
}

test('a clean draft keeps the model verdict and records the scan', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN));
  assert.equal(review.pass, true);
  assert.equal(review.score, 88);
  assert.equal(review.issues.length, 0);
  assert.deepEqual(review.slop, { score: 100, words: 12, findings: 0 });
});

test('a clean draft with all three passes clean still passes, and records them', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN), passingAudits());
  assert.equal(review.pass, true);
  assert.equal(review.issues.length, 0);
  assert.equal(review.competitorDelta?.verdict, 'adds-substantially');
  assert.deepEqual(review.claimAudit, { checked: 2, unsupported: 0 });
  assert.equal(review.positionCheck?.takesStance, true);
  assert.equal(review.dimensions!.evidence, 90, 'a fully supported draft is not capped');
  assert.equal(review.dimensions!.position, 86);
});

test('the voice scan vetoes a passing verdict', () => {
  const review = finalizeReview(verdict(), detectSlop(SLOPPY));
  assert.equal(review.pass, false, 'banned vocabulary must block the pass');
  assert.ok(review.issues.some((i) => i.severity === 'high'));
  assert.ok(review.issues.every((i) => i.issue.startsWith(ISSUE_PREFIX.scan)));
});

test('the scan caps the overall score', () => {
  const slop = detectSlop(SLOPPY);
  const review = finalizeReview(verdict(), slop);
  assert.ok(review.score <= slop.score, `${review.score} should be capped by ${slop.score}`);
  // Dimensions the scan says nothing about are left alone.
  assert.equal(review.dimensions!.evidence, 90);
});

test('a weak link dimension caps the score - the affiliate contract is load-bearing', () => {
  const review = finalizeReview(
    verdict({ dimensions: { evidence: 90, position: 86, structure: 90, citability: 88, links: 40 } }),
    detectSlop(CLEAN),
  );
  assert.equal(review.score, 40);
  assert.equal(review.pass, false);
});

test('a draft that lost its shape is capped by the structure dimension', () => {
  const review = finalizeReview(
    verdict({ dimensions: { evidence: 90, position: 86, structure: 45, citability: 88, links: 92 } }),
    detectSlop(CLEAN),
  );
  assert.equal(review.score, 45, 'structure is a structural cap, like links');
  assert.equal(review.pass, false);
});

test('a strong evidence or position score never lifts the composite past the caps', () => {
  const review = finalizeReview(
    verdict({ dimensions: { evidence: 100, position: 100, structure: 55, citability: 100, links: 100 } }),
    detectSlop(CLEAN),
  );
  assert.equal(review.score, 55);
});

test("the model's own issues survive the merge, scan issues are appended", () => {
  const review = finalizeReview(
    verdict({
      pass: false,
      score: 62,
      issues: [{ severity: 'medium', issue: 'No comparison table', fix: 'Add one.' }],
    }),
    detectSlop(SLOPPY),
  );
  assert.equal(review.issues[0].issue, 'No comparison table');
  assert.ok(review.issues.length > 1);
});

test('scan issues carry the line number and an example, once each', () => {
  const review = finalizeReview(verdict(), detectSlop(`Fine opening line.\n\n${SLOPPY}`));
  const filed = review.issues.filter((i) => i.issue.includes('delves'));
  assert.equal(filed.length, 1, 'a finding is filed once, not once per pass');
  assert.match(filed[0].issue, /"delves"/);
  assert.match(filed[0].issue, /line 3/);
  assert.match(filed[0].fix, /Replace with/);
});

test('a high-severity model issue blocks a pass even with a clean scan', () => {
  const review = finalizeReview(
    verdict({ issues: [{ severity: 'high', issue: 'Invented a price', fix: 'Cut it.' }] }),
    detectSlop(CLEAN),
  );
  assert.equal(review.pass, false);
});

test('a score below 80 never passes, whatever the model claims', () => {
  assert.equal(finalizeReview(verdict({ score: 79 }), detectSlop(CLEAN)).pass, false);
});

test('a malformed model verdict degrades instead of throwing', () => {
  const review = finalizeReview({} as SeoReview, detectSlop(CLEAN));
  assert.equal(review.pass, false);
  assert.equal(review.score, 0);
  assert.deepEqual(review.issues, []);
  assert.equal(review.dimensions!.citability, 0);
  assert.equal(review.competitorDelta, undefined);
  assert.equal(review.claimAudit, undefined);
});

test('dimensions fall back to the overall score when the model omits them', () => {
  const review = finalizeReview(
    { score: 84, pass: true, issues: [], summary: '' } as SeoReview,
    detectSlop(CLEAN),
  );
  assert.equal(review.dimensions!.evidence, 84);
  assert.equal(review.dimensions!.structure, 84);
  assert.equal(review.score, 84);
  assert.equal(review.pass, true);
});

// --- Claim audit ------------------------------------------------------------

test('an unsupported specific is a hard fail, not a style note', () => {
  const audit = claims({
    claims: [
      { claim: '$229', kind: 'price', supported: true, support: 'products[0].approxPrice' },
      { claim: '62 dB at one metre', kind: 'number', supported: false, support: 'no dossier entry measures noise' },
    ],
  });
  const review = finalizeReview(verdict(), detectSlop(CLEAN), passingAudits({ claims: audit }));
  const filed = review.issues.find((i) => i.issue.startsWith(ISSUE_PREFIX.claim));
  assert.ok(filed, 'an unsupported specific must be filed');
  assert.equal(filed!.severity, 'high');
  assert.match(filed!.issue, /62 dB at one metre/);
  assert.match(filed!.issue, /no dossier entry measures noise/);
  assert.match(filed!.fix, /Cut it/);
  assert.equal(review.pass, false, 'a fabricated specific blocks the pass');
  assert.deepEqual(review.claimAudit, { checked: 2, unsupported: 1 });
  assert.equal(review.dimensions!.evidence, 50, 'evidence is capped by the share the dossier carries');
});

test('a claim the model did not vouch for counts as unsupported', () => {
  const audit = normaliseClaimAudit({
    claims: [{ claim: 'IP67', kind: 'spec', support: 'unclear' }],
  });
  assert.equal(audit.claims[0].supported, false);
  const review = finalizeReview(verdict(), detectSlop(CLEAN), passingAudits({ claims: audit }));
  assert.equal(review.pass, false);
});

test('a long run of unsupported specifics is rolled up rather than listed forever', () => {
  const audit = claims({
    claims: Array.from({ length: 20 }, (_, i) => ({
      claim: `figure ${i}`,
      kind: 'number' as const,
      supported: false,
      support: '',
    })),
  });
  const review = finalizeReview(verdict(), detectSlop(CLEAN), passingAudits({ claims: audit }));
  const filed = review.issues.filter((i) => i.issue.startsWith(ISSUE_PREFIX.claim));
  assert.equal(filed.length, 13, '12 filed individually plus one roll-up');
  assert.match(filed[12].issue, /8 further specific/);
  assert.equal(review.dimensions!.evidence, 0);
});

test('a substantial draft with no checkable specific at all fails', () => {
  const slop = detectSlop(LONG_CLEAN);
  assert.ok(slop.words >= 400, `fixture should be long enough, got ${slop.words}`);
  const review = finalizeReview(verdict(), slop, passingAudits({ claims: claims({ claims: [] }) }));
  const filed = review.issues.find((i) => i.issue.includes('no checkable specific'));
  assert.ok(filed, 'a piece with nothing checkable in it is the generic failure itself');
  assert.equal(filed!.severity, 'high');
  assert.equal(review.pass, false);
});

test('a short draft with no specifics is not failed for length it never had', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({ claims: claims({ claims: [] }) }),
  );
  assert.equal(review.issues.length, 0);
  assert.equal(review.pass, true);
});

test('no claim audit at all leaves evidence and the pass alone', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN), { claims: null });
  assert.equal(review.dimensions!.evidence, 90);
  assert.equal(review.claimAudit, undefined);
  assert.equal(review.pass, true);
});

// --- Competitor delta -------------------------------------------------------

test('a piece that adds nothing to the top results fails', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({ competitors: delta({ verdict: 'adds-nothing', additions: [], duplicated: ['the same five picks'] }) }),
  );
  const filed = review.issues.find((i) => i.issue.startsWith(ISSUE_PREFIX.delta));
  assert.ok(filed, 'zero information gain must be filed');
  assert.equal(filed!.severity, 'high');
  assert.match(filed!.issue, /https:\/\/a\.example\/best/);
  assert.equal(review.pass, false);
  assert.equal(review.dimensions!.position, 40, 'adding nothing caps the position dimension');
});

test('a delta with no additions fails even when the model called it marginal', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({ competitors: delta({ verdict: 'adds-marginally', additions: [] }) }),
  );
  assert.ok(review.issues.some((i) => i.issue.startsWith(ISSUE_PREFIX.delta)));
  assert.equal(review.pass, false);
});

test('a plan that captured no competitors cannot fail a draft for adding nothing', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN), passingAudits({ competitors: null }));
  assert.ok(!review.issues.some((i) => i.issue.startsWith(ISSUE_PREFIX.delta)));
  assert.equal(review.pass, true);
  assert.equal(review.competitorDelta, undefined);
});

// --- Position ---------------------------------------------------------------

test('a draft that takes no stance fails', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({ position: position({ takesStance: false, stance: '' }) }),
  );
  const filed = review.issues.find((i) => i.issue.startsWith(ISSUE_PREFIX.position));
  assert.ok(filed);
  assert.equal(filed!.severity, 'high');
  assert.match(filed!.issue, /takes no stance/);
  assert.equal(review.pass, false);
  assert.equal(review.dimensions!.position, 40);
});

test('recommending everything equally fails', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({ position: position({ recommendsEverythingEqually: true }) }),
  );
  assert.ok(review.issues.some((i) => /argued against/.test(i.issue)));
  assert.equal(review.pass, false);
});

test('an empty cons list fails, and so does a hedged one', () => {
  const review = finalizeReview(
    verdict(),
    detectSlop(CLEAN),
    passingAudits({
      position: position({
        picks: [
          { pick: 'Dyson V15', cons: [], hedged: false },
          { pick: 'Shark Detect Pro', cons: ['may not suit everyone'], hedged: true },
        ],
      }),
    }),
  );
  const filed = review.issues.filter((i) => i.issue.startsWith(ISSUE_PREFIX.position));
  assert.equal(filed.length, 2);
  assert.match(filed[0].issue, /no cons at all/);
  assert.match(filed[1].issue, /hedged cons/);
  assert.equal(review.pass, false);
});

test('no position check at all leaves the pass alone', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN), { position: null });
  assert.equal(review.pass, true);
  assert.equal(review.positionCheck, undefined);
});

// --- Pass normalisation -----------------------------------------------------

test('a junk delta reply degrades to "adds nothing" rather than throwing', () => {
  const normalised = normaliseDelta({ additions: 'nope', verdict: 'excellent' }, ['https://a.example']);
  assert.deepEqual(normalised.additions, []);
  assert.equal(normalised.verdict, 'adds-nothing');
  assert.deepEqual(normalised.comparedWith, ['https://a.example']);
  assert.equal(normaliseDelta(null, []).verdict, 'adds-nothing');
  assert.equal(
    normaliseDelta({ additions: [], verdict: 'adds-substantially' }, []).verdict,
    'adds-nothing',
    'a generous verdict with nothing behind it does not survive',
  );
});

test('a delta keeps the model verdict when it named real additions', () => {
  const normalised = normaliseDelta(
    { additions: [{ claim: 'x', absentFrom: 'u', evidence: 'e' }, { claim: '  ' }], verdict: 'adds-marginally' },
    ['https://a.example'],
  );
  assert.equal(normalised.additions.length, 1, 'an addition with no claim is not an addition');
  assert.equal(normalised.verdict, 'adds-marginally');
});

test('a junk claim audit degrades to an empty audit', () => {
  assert.deepEqual(normaliseClaimAudit(undefined), { claims: [], notes: '' });
  const odd = normaliseClaimAudit({ claims: [{ claim: 'x', kind: 'vibes', supported: true }] });
  assert.equal(odd.claims[0].kind, 'number', 'an unknown kind falls back rather than escaping the union');
});

test('a junk position reply reads as no stance', () => {
  const normalised = normalisePosition({ picks: [{ pick: '', cons: ['x'] }] });
  assert.equal(normalised.takesStance, false);
  assert.deepEqual(normalised.picks, []);
});
