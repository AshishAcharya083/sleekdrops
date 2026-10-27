/**
 * The methodology page's addresses and the arithmetic behind what it
 * publishes: band ranges, the distribution of scores given, the changelog's
 * order and folding, and the state-driven lines that must agree with the data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { categories } from '../data/categories.ts';
import type { CategorySlug } from '../data/categories-types.ts';
import { SCORE_CHANGES, scoreChangesFor, type ScoreChange } from '../data/score-changes.ts';
import {
  badgeGlossaryHref,
  bandRange,
  categoryMethodHref,
  foldAfter,
  formatShare,
  INDEPENDENCE_MECHANISM,
  methodChangelog,
  methodologyHref,
  methodologyUpdated,
  methodVersionHref,
  nextVersions,
  PAID_LINK_NOTE,
  UNVERSIONED_SCORE_NOTE,
  publishedScoresEffect,
  scoreBandHref,
  scoreChangeCountLabel,
  scoreChangeWhy,
  scoreDistribution,
} from './methodology.ts';
import {
  BADGE_REGISTRY,
  isCheckDay,
  METHOD_VERSION_IDS,
  METHOD_VERSIONS,
  SCORE_BANDS,
  type BadgeKind,
  type MethodVersion,
  type MethodVersionEntry,
} from './trust.ts';

test('links land on the frozen anchors, including the one the Review JSON-LD already emits', () => {
  assert.equal(methodologyHref(), '/how-we-rate');
  assert.equal(methodologyHref('bands'), '/how-we-rate#bands');
  assert.equal(methodologyHref('score-changes'), '/how-we-rate#score-changes');
  assert.equal(methodVersionHref('1.0'), '/how-we-rate#method-v1-0');
  assert.equal(scoreBandHref('strong'), '/how-we-rate#band-strong');
  assert.equal(badgeGlossaryHref('review-score'), '/how-we-rate#badge-review-score');
  assert.equal(categoryMethodHref('finance'), '/how-we-rate#category-finance');
});

test('every band, registry badge, method version and category gets its own anchor', () => {
  const kinds = Object.keys(BADGE_REGISTRY) as BadgeKind[];
  assert.deepEqual(
    kinds.map(badgeGlossaryHref),
    kinds.map((kind) => `/how-we-rate#badge-${kind}`),
  );
  assert.deepEqual(
    SCORE_BANDS.map((band) => scoreBandHref(band.id)),
    SCORE_BANDS.map((band) => `/how-we-rate#band-${band.id}`),
  );
  assert.deepEqual(
    categories.map((category) => categoryMethodHref(category.slug as CategorySlug)),
    ['tech', 'home', 'fashion', 'health', 'finance', 'travel'].map((slug) => `/how-we-rate#category-${slug}`),
  );
  const anchors = [
    ...kinds.map(badgeGlossaryHref),
    ...SCORE_BANDS.map((band) => scoreBandHref(band.id)),
    ...categories.map((category) => categoryMethodHref(category.slug as CategorySlug)),
    ...METHOD_VERSIONS.map((entry) => methodVersionHref(entry.version)),
  ];
  assert.equal(new Set(anchors).size, anchors.length);
});

test('a version\'s anchor turns every dot into a dash', () => {
  assert.equal(methodVersionHref('2.10' as MethodVersion), '/how-we-rate#method-v2-10');
});

test('the paid-link note is the frozen sentence', () => {
  assert.equal(PAID_LINK_NOTE, 'Paid link. We may earn a commission if you buy. It never affects the score.');
});

test('the note beside an unversioned score names no version it cannot vouch for', () => {
  assert.doesNotMatch(UNVERSIONED_SCORE_NOTE, /\d/);
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
  const { shown, folded } = foldAfter(log, 2);
  assert.deepEqual(shown.map((entry) => entry.version), ['2.0', '1.2']);
  assert.deepEqual(folded.map((entry) => entry.anchor), ['method-v1-1', 'method-v1-0'], 'folded entries keep their ids');
  assert.equal(foldAfter(log.slice(0, 2), 2).folded.length, 0);
});

test('the version rules name the next steps from the current version', () => {
  assert.deepEqual(nextVersions('1.0'), { major: '2.0', minor: '1.1' });
});

const change = (date: string, overrides: Partial<ScoreChange> = {}): ScoreChange => ({
  slug: 'kettle-review',
  date,
  from: 4.6,
  to: 4.3,
  cause: 'retest',
  methodVersion: '1.0',
  reason: 'owner reports of failures rose.',
  ...overrides,
});

test('"Published scores" says what is true for the scores that exist', () => {
  const [first] = methodChangelog();
  assert.match(publishedScoresEffect(first, 0, []), /^No scores were published before this version/);
  assert.match(publishedScoresEffect(first, 320, []), /^None moved\. Reviews published before this date were scored the same way/);
  assert.match(
    publishedScoresEffect(first, 320, [change('2027-01-01'), change('2027-02-01'), change('2027-03-01')]),
    /^None moved by this version\. Every score change since, 3 so far,/,
  );
  const [major, minor] = methodChangelog(history('1.0', '1.1', '2.0'));
  const rescore = change('2027-04-01', { cause: 'method', methodVersion: '2.0' as MethodVersion });
  assert.match(publishedScoresEffect(major, 320, [rescore, change('2027-02-01')]), /re-checked\. 1 re-scored so far/);
  assert.equal(publishedScoresEffect(minor, 320, []), 'None moved.');
});

test('the score-change log header counts changes since the first method version', () => {
  assert.equal(scoreChangeCountLabel(0), 'since Method v1.0');
  assert.equal(scoreChangeCountLabel(1), '1 change since Method v1.0');
  assert.equal(scoreChangeCountLabel(14), '14 changes since Method v1.0');
});

test('a review\'s score changes come newest first, and none for a review whose score never moved', () => {
  const log = [change('2026-12-04'), change('2027-02-11'), change('2027-01-28', { slug: 'other-review' }), change('2027-01-02')];
  assert.deepEqual(scoreChangesFor('kettle-review', log).map((c) => c.date), ['2027-02-11', '2027-01-02', '2026-12-04']);
  assert.deepEqual(scoreChangesFor('no-such-review', log), []);
  assert.deepEqual(scoreChangesFor('no-such-review'), []);
});

test('the "Why" cell says what moved the score before the reason', () => {
  assert.equal(scoreChangeWhy(change('2027-01-01')), 'Re-checked: owner reports of failures rose.');
  assert.equal(scoreChangeWhy(change('2027-01-01', { cause: 'correction' })), 'Correction: owner reports of failures rose.');
  assert.equal(
    scoreChangeWhy(change('2027-01-01', { cause: 'method', methodVersion: '2.0' as MethodVersion })),
    'Re-scored under Method v2.0: owner reports of failures rose.',
  );
});

test('every recorded score change is a real move on a real day under a published method version', () => {
  for (const entry of SCORE_CHANGES) {
    assert.ok(isCheckDay(entry.date), `${entry.slug}: ${entry.date} is not a YYYY-MM-DD day`);
    assert.ok(METHOD_VERSION_IDS.includes(entry.methodVersion), `${entry.slug}: unknown method version`);
    for (const score of [entry.from, entry.to]) {
      assert.ok(score >= 1 && score <= 5 && Number(score.toFixed(1)) === score, `${entry.slug}: ${score} is not a 1-5 one-decimal score`);
    }
    assert.notEqual(entry.from, entry.to, `${entry.slug}: a change has to move the score`);
  }
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
