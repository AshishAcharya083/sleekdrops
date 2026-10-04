/**
 * The methodology page's addresses and the arithmetic behind what it
 * publishes: band ranges, the distribution of scores given, the changelog's
 * order and folding, and the state-driven lines that must agree with the data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { categories } from '../data/categories.ts';
import type { CategorySlug } from '../data/categories-types.ts';
import type { ScoreChange } from '../data/score-changes.ts';
import {
  badgeGlossaryHref,
  bandRange,
  categoryMethodHref,
  foldNewestFirst,
  formatShare,
  INDEPENDENCE_MECHANISM,
  methodChangelog,
  methodologyHref,
  methodologyUpdated,
  methodVersionHref,
  nextVersions,
  publishedScoresEffect,
  scoreChangeCountLabel,
  scoreChangesNewestFirst,
  scoreDistribution,
} from './methodology.ts';
import { BADGE_KINDS, METHOD_VERSIONS, SCORE_BANDS, type MethodVersion, type MethodVersionEntry } from './trust.ts';

test('links land on the frozen anchors, including the one the Review JSON-LD already emits', () => {
  assert.equal(methodologyHref(), '/how-we-rate');
  assert.equal(methodologyHref('bands'), '/how-we-rate#bands');
  assert.equal(methodVersionHref('1.0'), '/how-we-rate#method-v1-0');
  assert.equal(badgeGlossaryHref('review-score'), '/how-we-rate#badge-review-score');
  assert.equal(categoryMethodHref('finance'), '/how-we-rate#category-finance');
});

test('every registry badge and every category gets its own anchor', () => {
  const anchors = [
    ...BADGE_KINDS.map(badgeGlossaryHref),
    ...categories.map((category) => categoryMethodHref(category.slug as CategorySlug)),
    ...METHOD_VERSIONS.map((entry) => methodVersionHref(entry.version)),
  ];
  assert.equal(new Set(anchors).size, anchors.length);
  assert.equal(categories.length, 6);
});

test('band ranges cover the scale without gaps, and the lowest reads "Below"', () => {
  assert.deepEqual(SCORE_BANDS.map((band) => bandRange(band)), [
    '4.5–5.0',
    '4.0–4.4',
    '3.5–3.9',
    '3.0–3.4',
    'Below 3.0',
  ]);
});

test('the distribution of no scores is empty, with no average to misquote', () => {
  const empty = scoreDistribution([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.average, undefined);
  assert.equal(empty.median, undefined);
  assert.equal(empty.bands.length, SCORE_BANDS.length);
  assert.ok(empty.bands.every((entry) => entry.count === 0 && entry.share === 0));
});

test('the distribution counts by printed band and reports mean and median', () => {
  const dist = scoreDistribution([4.46, 4.7, 4.2, 2.1]);
  assert.equal(dist.count, 4);
  assert.deepEqual(
    dist.bands.map((entry) => [entry.band.id, entry.count]),
    [['excellent', 2], ['strong', 1], ['decent', 0], ['mixed', 0], ['weak', 1]],
    '4.46 prints as 4.5, so it is counted as Excellent',
  );
  assert.equal(dist.bands[0].share, 0.5);
  assert.ok(Math.abs(dist.average! - 3.865) < 1e-9);
  assert.ok(Math.abs(dist.median! - 4.33) < 1e-9, 'an even count takes the mean of the middle two');
  assert.equal(scoreDistribution([4.1, 3.2, 4.8]).median, 4.1);
});

test('a share that is there but rounds to nothing still shows', () => {
  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(1 / 320), '<1%');
  assert.equal(formatShare(4 / 320), '1%');
  assert.equal(formatShare(241 / 320), '75%');
});

const history = (...versions: string[]): MethodVersionEntry[] =>
  versions.map((version, index) => ({
    version: version as MethodVersion,
    date: `2027-0${index + 1}-01`,
    summary: `v${version}`,
  }));

test('the shipped changelog is v1.0 alone: the first version, current, on its stable anchor', () => {
  const [entry, ...rest] = methodChangelog();
  assert.equal(rest.length, 0);
  assert.equal(entry.version, '1.0');
  assert.equal(entry.anchor, 'method-v1-0');
  assert.equal(entry.kind, 'first');
  assert.equal(entry.current, true);
});

test('a longer changelog reads newest first, with major and minor steps told apart', () => {
  const log = methodChangelog(history('1.0', '1.1', '1.2', '2.0'));
  assert.deepEqual(
    log.map((entry) => [entry.version, entry.kind, entry.current]),
    [['2.0', 'major', true], ['1.2', 'minor', false], ['1.1', 'minor', false], ['1.0', 'first', false]],
  );
  const { recent, older } = foldNewestFirst(log, 2);
  assert.deepEqual(recent.map((entry) => entry.version), ['2.0', '1.2']);
  assert.deepEqual(older.map((entry) => entry.anchor), ['method-v1-1', 'method-v1-0'], 'folded entries keep their ids');
  assert.equal(foldNewestFirst(log.slice(0, 2), 2).older.length, 0);
});

test('the version rules name the next steps from the current version', () => {
  assert.deepEqual(nextVersions('1.0'), { major: '2.0', minor: '1.1' });
});

test('"Published scores" says what is true for the scores that exist', () => {
  const [first] = methodChangelog();
  assert.match(publishedScoresEffect(first, 0, 0), /^No scores were published before this version/);
  assert.match(publishedScoresEffect(first, 320, 0), /^None moved\. Reviews published before this date carry Method v1\.0/);
  assert.match(publishedScoresEffect(first, 320, 3), /^None moved by the method\./);
  const [major, minor] = methodChangelog(history('1.0', '1.1', '2.0'));
  assert.match(publishedScoresEffect(major, 320, 0), /re-checked/);
  assert.equal(publishedScoresEffect(minor, 320, 0), 'None moved.');
});

const change = (date: string): ScoreChange => ({
  date,
  reviewSlug: 'kettle-review',
  reviewTitle: 'Kettle review',
  from: 4.6,
  to: 4.3,
  reason: 'Re-checked.',
});

test('the score-change log header counts changes since the first method version', () => {
  assert.equal(scoreChangeCountLabel(0), 'since Method v1.0');
  assert.equal(scoreChangeCountLabel(1), '1 change since Method v1.0');
  assert.equal(scoreChangeCountLabel(14), '14 changes since Method v1.0');
  assert.deepEqual(
    scoreChangesNewestFirst([change('2026-12-04'), change('2027-02-11'), change('2027-01-28')]).map((c) => c.date),
    ['2027-02-11', '2027-01-28', '2026-12-04'],
  );
});

test('"Last updated" is the later of the newest version and the newest score change', () => {
  assert.equal(methodologyUpdated(METHOD_VERSIONS, []), METHOD_VERSIONS.at(-1)!.date);
  assert.equal(methodologyUpdated(METHOD_VERSIONS, [change('2027-02-11'), change('2026-12-04')]), '2027-02-11');
});

test('the independence mechanism states all four rules', () => {
  assert.equal(INDEPENDENCE_MECHANISM.length, 4);
  assert.match(INDEPENDENCE_MECHANISM.join(' '), /commission rates/);
  assert.match(INDEPENDENCE_MECHANISM.join(' '), /no affiliate program/);
});
