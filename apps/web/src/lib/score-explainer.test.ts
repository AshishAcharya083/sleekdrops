/**
 * The Quick Verdict's score explainer, as the verdict box reads it: honest
 * fallbacks for the reviews that predate the trust fields, and the record
 * printed as it stands when they are there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreExplainer, type ScoreExplainerInput } from './score-explainer.ts';
import { PROVENANCE_COPY, SCORE_BAND_IDS } from './trust.ts';

/** A review as the roughly 320 already published carry it: none of the new fields. */
const legacy: ScoreExplainerInput = {
  slug: 'sony-wh-1000xm5-review',
  product: { rating: 4.7 },
  author: { name: 'SleekDrops Editorial Team', beat: 'Tech' },
  pubDate: new Date('2025-03-03'),
};

const withProduct = (
  product: Partial<ScoreExplainerInput['product']>,
  extra: Partial<ScoreExplainerInput> = {},
): ScoreExplainerInput => ({ ...legacy, ...extra, product: { ...legacy.product, ...product } });

test('a legacy review falls back to not hands-on and an unversioned method, inventing nothing', () => {
  const view = scoreExplainer(legacy);

  assert.equal(view.score, '4.7');
  assert.equal(view.band.label, 'Excellent');
  assert.equal(view.handsOn, false);
  assert.equal(view.srSummary, 'Research score 4.7 out of 5: Excellent.');
  assert.deepEqual(view.provenance, { id: 'not-hands-on', ...PROVENANCE_COPY['not-hands-on'] });
  assert.deepEqual(view.method, {
    version: undefined,
    statement: 'Scored before we numbered our method.',
    linkText: 'How we score',
    href: '/how-we-rate#bands',
  });
  assert.equal(view.byline.published.iso, '2025-03-03');
  assert.equal(view.byline.updated, undefined);
  assert.equal(view.change, undefined);
  assert.equal(view.subScores, undefined);
  assert.match(view.explainer.paragraphs.join(' '), /before we numbered our method.*not been re-scored since/);
});

test('a versioned review names its method and links that version in the changelog', () => {
  const view = scoreExplainer(withProduct({ methodVersion: '1.0' }));
  assert.deepEqual(view.method, { version: '1.0', label: 'Method v1.0', href: '/how-we-rate#method-v1-0' });
  assert.doesNotMatch(view.explainer.paragraphs.join(' '), /numbered our method/);
});

test('the updated date is shown only when it is a different day from the published one', () => {
  const sameDay = scoreExplainer({ ...legacy, updatedDate: new Date('2025-03-03') });
  assert.equal(sameDay.byline.updated, undefined);

  const later = scoreExplainer({ ...legacy, updatedDate: new Date('2026-09-28') });
  assert.equal(later.byline.updated?.iso, '2026-09-28');
});

test('a review unit record decides provenance when the product records none', () => {
  const loan = scoreExplainer({ ...legacy, reviewUnit: { acquisition: 'loan' } });
  assert.equal(loan.provenance.id, 'brand-sample');
  assert.equal(loan.handsOn, true);
  assert.equal(loan.srSummary, 'Score 4.7 out of 5: Excellent.');
  assert.match(loan.explainer.gist, /our own weeks with the unit/);

  const none = scoreExplainer({ ...legacy, reviewUnit: { acquisition: 'none' } });
  assert.equal(none.provenance.id, 'not-hands-on');
});

test('a score revision is "Retested" only when the review was hands-on', () => {
  const scoreChange = { date: new Date('2026-09-28'), from: 4.1, reason: 'after a firmware update fixed the dropouts.' };

  const retested = scoreExplainer(withProduct({ rating: 4.3, provenance: 'retail', scoreChange }));
  assert.deepEqual(
    { label: retested.change?.label, from: retested.change?.from, to: retested.change?.to, reason: retested.change?.reason },
    { label: 'Retested', from: '4.1', to: '4.3', reason: 'after a firmware update fixed the dropouts' },
  );
  assert.equal(retested.change?.href, '/how-we-rate#corrections');

  const rescored = scoreExplainer(withProduct({ rating: 3.8, provenance: 'not-hands-on', scoreChange }));
  assert.equal(rescored.change?.label, 'Re-scored');
  assert.equal(rescored.change?.handsOn, false);
  // An unversioned score that was revised no longer claims it never was.
  assert.doesNotMatch(rescored.explainer.paragraphs.join(' '), /not been re-scored/);
});

test('sub-scores render with their weights and a total that says how it meets the headline', () => {
  const view = scoreExplainer(
    withProduct({
      rating: 4.4,
      subScores: [
        { label: 'Noise cancelling', score: 4.6, weight: 0.3 },
        { label: 'Sound', score: 4.4, weight: 0.25 },
        { label: 'Comfort', score: 4.2, weight: 0.2 },
        { label: 'Battery', score: 4.5, weight: 0.15 },
        { label: 'Value', score: 3.8, weight: 0.1 },
      ],
    }),
  );
  assert.deepEqual(view.subScores?.rows[0], { label: 'Noise cancelling', weight: '30% of score', score: '4.6', percent: 92 });
  assert.equal(view.subScores?.note, 'The weighted total, 4.38, rounds to the 4.4 above.');

  const offByOne = scoreExplainer(
    withProduct({
      rating: 4.4,
      subScores: [
        { label: 'A', score: 4.3, weight: 0.5 },
        { label: 'B', score: 4.4, weight: 0.5 },
      ],
    }),
  );
  assert.match(offByOne.subScores?.note ?? '', /4\.35, is within 0\.05 of the 4\.4 above/);
});

test('the scale covers 1.0 to 5.0 and marks only this review\'s band', () => {
  const { scale } = scoreExplainer(withProduct({ rating: 4.4 })).explainer;
  assert.equal(scale[0].range, '4.5–5.0');
  assert.equal(scale.at(-1)?.range, '1.0–2.9');
  assert.deepEqual(
    scale.filter((row) => row.current).map((row) => row.id),
    ['strong'],
  );
});

test('the analytics hook carries exactly the slug and a score band id', () => {
  const { hookProps } = scoreExplainer(withProduct({ rating: 3.2 })).explainer;
  assert.deepEqual(Object.keys(hookProps).sort(), ['band', 'slug']);
  assert.equal(hookProps.slug, 'sony-wh-1000xm5-review');
  assert.ok((SCORE_BAND_IDS as readonly string[]).includes(hookProps.band));
  assert.equal(hookProps.band, 'mixed');
});
