// finalizeReview is where a draft is actually cleared to publish, so it must
// hold without a live model: the deterministic voice scan has to be able to
// veto a model that liked the draft, and the merge must not lose the model's
// own issues while doing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeReview } from './seoReviewer.js';
import { detectSlop } from '../content/slop.js';
import type { SeoReview } from '../pipeline/types.js';

const CLEAN = 'The Ninja AF160 costs $229 at Amazon Australia. It holds 5.7 litres.';
const SLOPPY = 'This robust solution seamlessly delves into the audio landscape.';

/** A model verdict that would pass on its own. */
function verdict(overrides: Partial<SeoReview> = {}): SeoReview {
  return {
    score: 88,
    pass: true,
    issues: [],
    summary: 'Strong draft.',
    dimensions: { seo: 90, geo: 86, voice: 90, eeat: 88, links: 92 },
    ...overrides,
  };
}

test('a clean draft keeps the model verdict and records the scan', () => {
  const review = finalizeReview(verdict(), detectSlop(CLEAN));
  assert.equal(review.pass, true);
  assert.equal(review.score, 88);
  assert.equal(review.issues.length, 0);
  assert.deepEqual(review.slop, { score: 100, words: 12, findings: 0 });
});

test('the voice scan vetoes a passing verdict', () => {
  const review = finalizeReview(verdict(), detectSlop(SLOPPY));
  assert.equal(review.pass, false, 'banned vocabulary must block the pass');
  assert.ok(review.issues.some((i) => i.severity === 'high'));
  assert.ok(review.issues.every((i) => i.issue.startsWith('Voice scan —')));
});

test('the scan caps the voice dimension and the overall score', () => {
  const slop = detectSlop(SLOPPY);
  const review = finalizeReview(verdict(), slop);
  assert.equal(review.dimensions!.voice, slop.score);
  assert.ok(review.score <= slop.score, `${review.score} should be capped by ${slop.score}`);
  // Dimensions the scan says nothing about are left alone.
  assert.equal(review.dimensions!.seo, 90);
});

test('a weak link dimension caps the score too — the affiliate contract is load-bearing', () => {
  const review = finalizeReview(
    verdict({ dimensions: { seo: 90, geo: 86, voice: 90, eeat: 88, links: 40 } }),
    detectSlop(CLEAN),
  );
  assert.equal(review.score, 40);
  assert.equal(review.pass, false);
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

test('scan issues carry the line number and an example', () => {
  const review = finalizeReview(verdict(), detectSlop(`Fine opening line.\n\n${SLOPPY}`));
  const issue = review.issues.find((i) => i.issue.includes('delves'));
  assert.ok(issue, 'expected a finding for "delves"');
  assert.match(issue!.issue, /"delves"/);
  assert.match(issue!.issue, /line 3/);
  assert.match(issue!.fix, /Replace with/);
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
  assert.equal(review.dimensions!.geo, 0);
});

test('dimensions fall back to the overall score when the model omits them', () => {
  const review = finalizeReview(
    { score: 84, pass: true, issues: [], summary: '' } as SeoReview,
    detectSlop(CLEAN),
  );
  assert.equal(review.dimensions!.seo, 84);
  assert.equal(review.dimensions!.geo, 84);
  assert.equal(review.score, 84);
  assert.equal(review.pass, true);
});
