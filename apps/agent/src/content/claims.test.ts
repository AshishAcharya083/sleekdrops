// The tier a figure is printed at, and the two rules that are not allowed to
// be advice to a model.
//
// The tier is derived from who produced a number, never from what the dossier
// declared it to be: a model that files a maker's spec with `ownTest: true`
// does not get to promote it, and a brand satisfaction survey does not become
// a measurement of a handset by being filed as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimProblems,
  claimTier,
  cohortRaterFor,
  COVERS_RULE,
  isUs,
  pageClaims,
  pickEvidence,
} from './claims.js';
import type { MeasuredClaim } from '../pipeline/types.js';

function claim(overrides: Partial<MeasuredClaim> = {}): MeasuredClaim {
  return {
    subject: 'iPhone 18 Pro',
    metric: 'Peak brightness',
    claimedValue: null,
    claimedBy: null,
    claimedSourceUrl: null,
    claimedConditions: null,
    measuredValue: null,
    measuredBy: null,
    conditions: null,
    measuredOn: null,
    measuredSourceUrl: null,
    withdrawnValue: null,
    ownTest: false,
    covers: null,
    ...overrides,
  };
}

test('a figure nobody has measured is a manufacturer claim, whatever else it carries', () => {
  const maker = claim({ claimedValue: '3,000 nits', claimedBy: 'Apple', ownTest: true });
  assert.equal(claimTier(maker), 'manufacturer');
});

test('a measurement by a protocol-publishing outlet is independent, not ours', () => {
  const measured = claim({
    measuredValue: '1,684 nits',
    measuredBy: 'Notebookcheck',
    measuredSourceUrl: 'https://www.notebookcheck.net/x',
  });
  assert.equal(claimTier(measured), 'independent');
});

test('only our own test reaches the top tier', () => {
  assert.equal(claimTier(claim({ measuredValue: '31 h', measuredBy: 'SleekDrops', ownTest: true })), 'measured');
  // The flag alone is not enough: somebody else's number stays theirs.
  assert.equal(claimTier(claim({ measuredValue: '31 h', measuredBy: 'GSMArena', ownTest: true })), 'independent');
  assert.ok(isUs('sleekdrops'));
  assert.equal(isUs('GSMArena'), false);
});

test('a brand-level rater is context, however it was filed', () => {
  const survey = claim({
    metric: 'Customer satisfaction',
    measuredValue: '4 stars',
    measuredBy: 'Canstar Blue',
    measuredSourceUrl: 'https://www.canstarblue.com.au/phones/apple',
  });
  assert.equal(claimTier(survey), 'context');
  assert.equal(cohortRaterFor('Canstar Blue')?.rater, 'Canstar Blue');
  assert.equal(cohortRaterFor(null, 'https://www.choice.com.au/x')?.rater, 'CHOICE');
  assert.equal(cohortRaterFor('GSMArena', 'https://www.gsmarena.com/x'), null);
});

test("a maker's figure with nobody to attribute it to is dropped, not printed", () => {
  // An unattributed maker number read in our own voice is the exposure the
  // whole surface exists to remove, so there is no fallback attribution.
  assert.deepEqual(pageClaims([claim({ claimedValue: '3,000 nits' })]), []);
  assert.deepEqual(pageClaims([claim({ claimedBy: 'Apple' })]), []);
});

test('both halves of a disputed spec reach the page, neither merged into the other', () => {
  const [page] = pageClaims([
    claim({
      metric: 'Battery life, screen-on',
      claimedValue: '29 hours',
      claimedBy: 'Apple',
      claimedConditions: 'video playback, brightness unstated',
      measuredValue: '16 h 42 min',
      measuredBy: 'GSMArena',
      conditions: 'Battery Life Test 2.0, fixed 200 nits',
      measuredOn: '2026-09-16',
      measuredSourceUrl: 'https://www.gsmarena.com/x',
    }),
  ]);
  assert.equal(page.tier, 'independent');
  assert.equal(page.value, '16 h 42 min');
  assert.equal(page.attribution, 'GSMArena');
  assert.equal(page.conditions, 'Battery Life Test 2.0, fixed 200 nits');
  assert.deepEqual(page.claimed, {
    value: '29 hours',
    by: 'Apple',
    conditions: 'video playback, brightness unstated',
  });
});

test('a pick is bound to its claims by slug, and the chip is always filled', () => {
  const claims = pageClaims(
    [claim({ subject: 'iPhone 18 Pro', measuredValue: '1,684 nits', measuredBy: 'Notebookcheck' })],
    (subject) => (subject === 'iPhone 18 Pro' ? 'iphone-18-pro' : undefined),
  );
  assert.equal(claims[0].goSlug, 'iphone-18-pro');
  assert.equal(pickEvidence({ name: 'iPhone 18 Pro', goSlug: 'iphone-18-pro' }, claims), 'researched');
  const ours = pageClaims([
    claim({ subject: 'iPhone 18 Pro', measuredValue: '1,684 nits', measuredBy: 'SleekDrops', ownTest: true }),
  ]);
  assert.equal(pickEvidence({ name: 'iPhone 18 Pro', goSlug: 'iphone-18-pro' }, ours), 'tested');
});

test('a cohort rating attached to a model it does not cover is refused', () => {
  const claims = pageClaims([
    claim({
      subject: 'iPhone 18 Pro',
      metric: 'Customer satisfaction',
      measuredValue: '4 stars',
      measuredBy: 'Canstar Blue',
      measuredSourceUrl: 'https://www.canstarblue.com.au/phones/apple',
      covers: 'Apple as a brand, 2026 mobile phone provider survey',
    }),
  ]);
  const problems = claimProblems(claims, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Canstar Blue rating to "iPhone 18 Pro"/);
  assert.match(problems[0], /never evidence about a model it does not cover/);
});

test('the same rating over coverage that names the model is allowed through', () => {
  const claims = pageClaims([
    claim({
      subject: 'iPhone 18 Pro',
      metric: 'Lab score',
      measuredValue: '82/100',
      measuredBy: 'CHOICE',
      measuredSourceUrl: 'https://www.choice.com.au/phones',
      covers: 'the 14 handsets CHOICE tested, including the iPhone 18 Pro',
    }),
  ]);
  assert.deepEqual(claimProblems(claims, []), []);
});

test('a lab result whose coverage names this model is a measurement of it, not context', () => {
  // CHOICE benches individual models through ICRT. Calling its result on the
  // model the page is about "context, not a measurement of this model" is the
  // mirror of the error the tiers exist to prevent - it understates the best
  // independent evidence a launch-window piece can have.
  const lab = claim({
    subject: 'iPhone 18 Pro',
    metric: 'Lab score',
    measuredValue: '82/100',
    measuredBy: 'CHOICE',
    measuredSourceUrl: 'https://www.choice.com.au/phones',
    covers: 'the 14 handsets CHOICE lab-tested in August 2026, including the iPhone 18 Pro',
  });
  assert.equal(claimTier(lab), 'independent');
  assert.equal(pageClaims([lab])[0].tier, 'independent');
  // Without a coverage line naming the model there is nothing saying the lab
  // ran this one, so it stays context - and claimProblems still refuses it.
  assert.equal(claimTier({ ...lab, covers: 'the 14 handsets CHOICE lab-tested in August 2026' }), 'context');
});

test('a brand survey is never promoted, whatever its coverage line says', () => {
  // No coverage wording turns a commissioned satisfaction panel into a test.
  const survey = claim({
    subject: 'iPhone 18 Pro',
    metric: 'Customer satisfaction',
    measuredValue: '4 stars',
    measuredBy: 'Canstar Blue',
    measuredSourceUrl: 'https://www.canstarblue.com.au/phones/apple',
    covers: 'Apple phone owners surveyed in 2026, including owners of the iPhone 18 Pro',
  });
  assert.equal(claimTier(survey), 'context');
  assert.deepEqual(claimProblems(pageClaims([survey]), []), []);
});

test('the brief the researcher is handed asks for exactly what the check enforces', () => {
  // The two used to contradict each other: the brief asked for "covers" only
  // where the rating was about something other than this model, and the check
  // then refused every row that followed it.
  for (const rater of ['Canstar Blue', 'CHOICE']) assert.match(COVERS_RULE, new RegExp(rater));
  assert.match(COVERS_RULE, /including when this exact model is one of them/);
  assert.match(COVERS_RULE, /refused in code/);
});

test('a badge resting on a maker claim alone fails, and that failure is correct', () => {
  const claims = pageClaims(
    [
      claim({
        subject: 'iPhone 18 Pro',
        metric: 'Peak brightness',
        claimedValue: '3,000 nits',
        claimedBy: 'Apple',
      }),
    ],
    () => 'iphone-18-pro',
  );
  const problems = claimProblems(claims, [
    { name: 'iPhone 18 Pro', goSlug: 'iphone-18-pro', badge: 'Best overall' },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never rests on a manufacturer claim alone/);
});

test('a badge with an independent measurement behind it ships', () => {
  const claims = pageClaims(
    [
      claim({
        subject: 'iPhone 18 Pro',
        metric: 'Peak brightness',
        measuredValue: '1,684 nits',
        measuredBy: 'Notebookcheck',
      }),
    ],
    () => 'iphone-18-pro',
  );
  assert.deepEqual(
    claimProblems(claims, [{ name: 'iPhone 18 Pro', goSlug: 'iphone-18-pro', badge: 'Best overall' }]),
    [],
  );
});

test('a pick with no badge is never asked to justify one', () => {
  assert.deepEqual(claimProblems([], [{ name: 'iPhone 18 Pro', goSlug: 'iphone-18-pro' }]), []);
});

test('an outlet that merely contains a rater’s name is not one', () => {
  // A substring test would fail the whole article over an unrelated outlet.
  assert.equal(cohortRaterFor('Your Choice Labs'), null);
  assert.equal(cohortRaterFor('CHOICE Australia')?.rater, 'CHOICE');
  assert.equal(cohortRaterFor('Canstar Blue 2026 survey')?.rater, 'Canstar Blue');
  assert.equal(cohortRaterFor(null, 'https://www.canstarblue.com.au/x')?.rater, 'Canstar Blue');
});

test('a row the frontmatter schema would refuse is dropped, not shipped', () => {
  // A schema failure fails the whole article. One incomplete row is not worth
  // a card that dies at assembly, so the row goes and the rest ships.
  const rows = pageClaims([
    claim({ subject: '', measuredValue: '1 nit', measuredBy: 'GSMArena' }),
    claim({
      subject: 'iPhone 18 Pro',
      measuredValue: '1,684 nits',
      measuredBy: 'Notebookcheck',
      measuredSourceUrl: "Notebookcheck's review",
      measuredOn: 'last September',
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceUrl, undefined, 'an unopenable link is dropped, the figure is not');
  assert.equal(rows[0].date, undefined);
});

test('coverage of the sibling model is not coverage of this one', () => {
  // "Galaxy S26" sits inside "Galaxy S26 Ultra". Read as a substring, a cohort
  // result over the Ultra promoted a rating of a handset the lab never put on
  // the bench into an independent measurement of this one - and the badge rule
  // would then let a "Best overall" rest on it.
  const sibling = claim({
    subject: 'Galaxy S26',
    metric: 'Lab score',
    measuredValue: '82/100',
    measuredBy: 'CHOICE',
    measuredSourceUrl: 'https://www.choice.com.au/phones',
    covers: 'the 12 handsets CHOICE lab-tested in August 2026, including the Galaxy S26 Ultra',
  });
  assert.equal(claimTier(sibling), 'context');
  const problems = claimProblems(pageClaims([sibling], () => 'galaxy-s26'), [
    { name: 'Galaxy S26', goSlug: 'galaxy-s26', badge: 'Best overall' },
  ]);
  assert.equal(problems.length, 2, 'the rating is refused, and the badge has nothing left to rest on');
  assert.match(problems[0], /never evidence about a model it does not cover/);
  assert.match(problems[1], /never rests on a manufacturer claim alone/);

  // A sibling is a sibling however the line is phrased.
  for (const covers of [
    'the 12 handsets CHOICE lab-tested in August 2026, including the Galaxy S26 Ultra',
    'the Galaxy S26+ and the Galaxy S26 Ultra, tested in August 2026',
    'the Galaxy S26 Ultra among them',
  ]) {
    assert.equal(claimTier({ ...sibling, covers }), 'context', covers);
  }

  // The same line naming this model, in the shapes a list of models actually
  // gets written in, is coverage of it - including where the sentence carries
  // on past the name.
  for (const covers of [
    'the 12 handsets CHOICE lab-tested in August 2026, including the Galaxy S26',
    'the Galaxy S26 Ultra, the Galaxy S26 and the Pixel 11 Pro',
    'the handsets CHOICE lab-tested in August 2026, Galaxy S26 among them',
    'the Galaxy S26 (August 2026 batch)',
    'the Samsung Galaxy S26',
  ]) {
    assert.equal(claimTier({ ...sibling, covers }), 'independent', covers);
  }
});

test('the brief tells the researcher how the coverage line is read', () => {
  assert.match(COVERS_RULE, /separated by commas or "and"/);
  assert.match(COVERS_RULE, /Galaxy S26 Ultra" is not coverage of the Galaxy S26/);
});
