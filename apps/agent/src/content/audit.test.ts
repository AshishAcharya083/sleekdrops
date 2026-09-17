// The corpus audit's arithmetic: what makes one published page rank below
// another, and what the operator is told to do about it.
//
// This is the half of the audit that must never drift. The reviewer pass is a
// model's judgement and will move; the fold from two measurements into one
// rank, the band thresholds and the ordering are decisions, and an operator
// working a worst-first list has to be able to trust that the same corpus
// ranks the same way twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseAuditReview, rankAudit, scoreAudited, type AuditReview } from './audit.js';
import type { SlopReport } from './slop.js';

const scan = (score: number, findings: SlopReport['findings'] = [], words = 1800): SlopReport => ({
  score,
  findings,
  words,
});

const review = (
  dimensions: AuditReview['dimensions'],
  score: number,
  summary = 'graded',
): AuditReview => ({ dimensions, score, summary, issues: [] });

const strong = review({ evidence: 85, position: 85, structure: 85, citability: 85 }, 85);
const weak = review({ evidence: 30, position: 35, structure: 40, citability: 50 }, 35);

test('the composite weighs the reviewer above the scanner', () => {
  const scored = scoreAudited({
    slug: 'beef-tallow-skincare',
    title: 'Beef tallow skincare',
    publishedAt: '2026-02-01',
    scan: scan(80),
    review: review({ evidence: 40, position: 40, structure: 40, citability: 40 }, 40),
  });
  // 80 * 0.4 + 40 * 0.6. The reviewer weighs more because "reads templated and
  // generic" is a judgement about worth, not a count of banned words.
  assert.equal(scored.score, 56);
});

test('a page whose scan is below the pipeline pass mark is a rebuild whatever a reviewer thought', () => {
  const scored = scoreAudited({
    slug: 'cordless-stick-vacuums',
    title: 'Best cordless stick vacuums',
    publishedAt: '2026-03-01',
    scan: scan(64),
    review: strong,
  });
  assert.ok(scored.score >= 55, 'the composite alone would have banded this as merely "review"');
  assert.equal(scored.band, 'requalify', 'the deterministic pass mark overrides it');
});

test('the bands split on the composite', () => {
  const band = (scanScore: number, reviewScore: number): string =>
    scoreAudited({
      slug: 's',
      title: 't',
      publishedAt: null,
      scan: scan(scanScore),
      review: review({ evidence: reviewScore, position: reviewScore, structure: reviewScore, citability: reviewScore }, reviewScore),
    }).band;

  assert.equal(band(90, 90), 'ok');
  assert.equal(band(90, 60), 'review');
  assert.equal(band(75, 40), 'requalify');
});

test('a page the reviewer could not grade is still ranked, on its scan alone', () => {
  const scored = scoreAudited({
    slug: 'portable-waterproof-bluetooth-speakers',
    title: 'Best portable waterproof Bluetooth speakers',
    publishedAt: '2026-01-15',
    scan: scan(72),
    review: null,
    reviewError: 'Claude engine not configured',
  });
  assert.equal(scored.score, 72, 'dropping it would hide exactly the pages that fail');
  assert.equal(scored.review, null);
  assert.match(scored.verdict, /no reviewer pass \(Claude engine not configured\)/);
});

test('the verdict names the weakest axes and the loudest scan rule', () => {
  const scored = scoreAudited({
    slug: 's',
    title: 't',
    publishedAt: null,
    scan: scan(58, [
      { category: 'uniformity', rule: 'Identical section openings', matches: [], count: 9, lines: [], fix: 'vary them' },
      { category: 'banned-word', rule: 'AI vocabulary: "delve"', matches: ['delve'], count: 1, lines: [4], fix: 'replace it' },
    ]),
    review: weak,
  });
  assert.match(scored.verdict, /weakest on evidence 30, position 35/);
  // Banned vocabulary outranks a shape measurement however loud the shape is.
  assert.match(scored.verdict, /top flag: AI vocabulary: "delve" ×1/);
  assert.equal(scored.worstRules[0].severity, 'high');
});

test('the ranking is worst first, and the same corpus ranks the same way twice', () => {
  const page = (slug: string, scanScore: number, reviewScore: number) =>
    scoreAudited({
      slug,
      title: slug,
      publishedAt: null,
      scan: scan(scanScore),
      review: review({ evidence: reviewScore, position: reviewScore, structure: reviewScore, citability: reviewScore }, reviewScore),
    });

  const report = rankAudit([page('good', 95, 92), page('bad', 60, 35), page('middling', 85, 60)], 'FIXED');

  assert.deepEqual(report.articles.map((a) => a.slug), ['bad', 'middling', 'good']);
  assert.equal(report.generatedAt, 'FIXED');
  assert.equal(report.scanned, 3);
  assert.deepEqual(report.bands, { requalify: 1, review: 1, ok: 1 });
  assert.deepEqual(report.requalify, ['bad'], 'the recommendation list is the requalify band');
  assert.match(report.summary, /3 published article\(s\) scored: 1 to requalify/);

  // Ties break deterministically on the scan and then the slug, so a second
  // run over an unchanged corpus does not reshuffle the operator's worklist.
  const tied = rankAudit([page('zulu', 80, 60), page('alpha', 80, 60)], 'FIXED');
  assert.deepEqual(tied.articles.map((a) => a.slug), ['alpha', 'zulu']);
});

test('an empty corpus reports itself rather than ranking nothing', () => {
  const report = rankAudit([], 'FIXED');
  assert.equal(report.scanned, 0);
  assert.deepEqual(report.requalify, []);
  assert.equal(report.summary, 'No published articles to audit.');
});

test('the reviewer reply is clamped, ordered and capped before it is stored', () => {
  const normalised = normaliseAuditReview({
    dimensions: { evidence: 140, position: -20, structure: 'nonsense', citability: 61.4 },
    score: 999,
    summary: '  thin  ',
    issues: [
      { severity: 'low', issue: 'low one', fix: 'a' },
      { severity: 'high', issue: 'high one', fix: 'b' },
      { severity: 'shouty', issue: 'unknown severity', fix: 'c' },
      { severity: 'medium', issue: 'medium one', fix: 'd' },
      { issue: '', fix: 'dropped - no issue text' },
      { severity: 'high', issue: 'high two', fix: 'e' },
      { severity: 'low', issue: 'low two', fix: 'f' },
      { severity: 'low', issue: 'low three', fix: 'g' },
    ],
  });

  assert.deepEqual(normalised.dimensions, {
    evidence: 100,
    position: 0,
    structure: 0,
    citability: 61,
  });
  assert.equal(normalised.score, 100);
  assert.equal(normalised.summary, 'thin');
  assert.equal(normalised.issues.length, 5, 'capped');
  assert.deepEqual(
    normalised.issues.slice(0, 3).map((i) => i.issue),
    ['high one', 'high two', 'medium one'],
    'worst first',
  );
  assert.equal(
    normalised.issues.every((i) => i.issue !== ''),
    true,
    'an issue with nothing in it is not an issue',
  );
});

test('a reply with no overall score falls back to its own axes', () => {
  const normalised = normaliseAuditReview({
    dimensions: { evidence: 40, position: 50, structure: 60, citability: 70 },
  });
  assert.equal(normalised.score, 55, 'ranking the page at zero would punish it for the model');
});
