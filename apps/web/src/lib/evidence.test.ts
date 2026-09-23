/**
 * What a reader is told about each number, and when.
 *
 * The three things this has to get right are the three things that cost a
 * publisher: a maker's figure never stated in our voice, a launch notice that
 * stops claiming "no independent test yet" the moment one publishes, and a
 * review-unit line that names who supplied the unit rather than saying
 * "supplied for review", which names nobody.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attributionLine,
  citationLabel,
  claimRowId,
  claimsByTier,
  comparesWithClaimed,
  EVIDENCE_PANEL_ID,
  evidenceAnchor,
  gapNote,
  makerFigureNote,
  methodLinkLabel,
  onSaleSentence,
  evidenceState,
  launchStatus,
  LAUNCH_WINDOW_DAYS,
  nameList,
  provenanceCopy,
  shownOfLabel,
  sourceRowId,
  tiersPresent,
  toClaimEntries,
  variance,
  varianceLabel,
  VARIANCE_THRESHOLD,
} from './evidence.ts';
import type { ClaimData } from '../content/frontmatter.ts';

const measuredByGsm: ClaimData = {
  subject: 'iPhone 18 Pro',
  metric: 'Battery life, screen-on',
  tier: 'independent',
  value: '16 h 42 min',
  attribution: 'GSMArena',
  conditions: 'Battery Life Test 2.0, fixed 200 nits',
  date: '2026-09-16',
  claimed: { value: '29 h', by: 'Apple', conditions: 'video playback, brightness unstated' },
};

const makerOnly: ClaimData = {
  subject: 'iPhone 18 Pro',
  metric: 'Peak brightness',
  tier: 'manufacturer',
  value: '3,000 nits',
  attribution: 'Apple',
};

test('each tier says a different thing, and every one of them says who', () => {
  assert.equal(
    attributionLine(measuredByGsm),
    'Independently measured by GSMArena, battery life, screen-on, Sep 16, 2026',
  );
  assert.equal(attributionLine(makerOnly), 'Apple claim, not independently verified');
  assert.equal(
    attributionLine({ ...measuredByGsm, tier: 'measured', attribution: 'SleekDrops', conditions: '200 nits, ANC on' }),
    'We measured it - 200 nits, ANC on, Sep 16, 2026',
  );
  assert.equal(
    attributionLine({
      subject: 'iPhone 18 Pro',
      metric: 'Satisfaction',
      tier: 'context',
      value: '4 stars',
      attribution: 'Canstar Blue',
      covers: 'Apple as a brand',
    }),
    // What it covers is printed beside the figure in its own line, so the
    // attribution does not repeat it.
    'Canstar Blue rating',
  );
});

test('a list of testers reads as a sentence, not as a CSV', () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['GSMArena']), 'GSMArena');
  assert.equal(nameList(['Notebookcheck', 'GSMArena']), 'Notebookcheck and GSMArena');
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C');
});

test('a maker’s figure is never restated as a measurement', () => {
  // The whole exposure in one line: the label has to survive the rendering,
  // and the figure has to stay attributed to whoever asserted it.
  const [entry] = toClaimEntries([makerOnly]);
  assert.equal(entry.chip, 'Manufacturer claim');
  assert.match(entry.attributionLine, /not independently verified/);
  assert.equal(entry.variance, null, 'nothing to compare it against');
});

test('a gap is only reported past the threshold this site publishes', () => {
  const [entry] = toClaimEntries([measuredByGsm]);
  assert.ok(entry.variance !== null && entry.variance < -0.4);
  assert.equal(entry.varianceShown, true);
  // The leading figure of each side, in the same unit: 16 hours against 29.
  // The trailing minutes are not parsed, which understates a gap rather than
  // overstating one - the safe direction for a number we publish as a finding.
  assert.equal(varianceLabel(entry.variance!), '-45%');

  const close = toClaimEntries([
    { ...measuredByGsm, value: '28 h', claimed: { value: '29 h', by: 'Apple' } },
  ])[0];
  assert.ok(Math.abs(close.variance!) < VARIANCE_THRESHOLD);
  assert.equal(close.varianceShown, false, 'a small difference between honest methods is not an accusation');
});

test('the gap column never claims an agreement it did not compute', () => {
  // "All-day battery" against a measured figure has no percentage between it.
  // Printing "they agree within 10%" over that pair would launder the maker's
  // phrase as consistent with a measurement nobody compared it to.
  const incomparable = toClaimEntries([
    {
      ...measuredByGsm,
      value: '6 h 10 min',
      claimed: { value: 'All-day battery', by: 'Apple' },
    },
  ])[0];
  assert.equal(incomparable.variance, null);
  assert.equal(incomparable.varianceShown, false);
  assert.match(gapNote(incomparable), /not directly comparable/);
  assert.doesNotMatch(gapNote(incomparable), /agree within/);

  const close = toClaimEntries([
    { ...measuredByGsm, value: '28 h', claimed: { value: '29 h', by: 'Apple' } },
  ])[0];
  assert.equal(gapNote(close), 'The two figures agree within 10%, so there is no gap worth reporting.');
});

test('a rating is never set against the maker’s figure as though it measured it', () => {
  // The side-by-side card heads its right column "Measured". A cohort or brand
  // rating printed there is a rating under a measurement's heading, and the
  // gap beside it is a comparison between a spec sheet and a survey that the
  // page would be asserting in its own voice.
  const rating: ClaimData = {
    subject: 'iPhone 18 Pro',
    metric: 'Peak brightness',
    tier: 'context',
    value: '4 stars',
    attribution: 'Canstar Blue',
    covers: 'Apple as a brand',
    claimed: { value: '3,000 nits', by: 'Apple' },
  };
  const [entry] = toClaimEntries([rating]);
  assert.equal(entry.comparison, false);
  assert.equal(entry.variance, null);
  assert.equal(entry.varianceShown, false);
  assert.equal(comparesWithClaimed(rating), false);
  // Dropped from the comparison, not from the page: the maker's figure is
  // still printed, attributed to the maker and clear of the rating.
  assert.equal(
    makerFigureNote(rating.claimed!),
    'Apple states 3,000 nits for this metric. Nobody independent has verified it, and the figure above does not measure it.',
  );
  assert.match(
    makerFigureNote({ value: '29 h', by: 'Apple', conditions: 'video playback' }),
    /29 h for this metric \(video playback\)\. Nobody/,
  );
  // A measurement of the same metric still compares, and still reports its gap.
  assert.equal(toClaimEntries([measuredByGsm])[0].comparison, true);
});

test('two figures in different units are not compared at all', () => {
  assert.equal(variance('29 h', '1,684 nits'), null);
  assert.equal(variance('A+', '31 hours'), null);
  assert.equal(variance('50 hrs', '31 hours'), -0.38);
  assert.equal(variance('2,140 nits', '1,684 nits')?.toFixed(3), '-0.213');
});

test('tiers are grouped strongest first, and empty tiers are not drawn', () => {
  const entries = toClaimEntries([makerOnly, measuredByGsm]);
  assert.deepEqual(tiersPresent(entries), ['independent', 'manufacturer']);
  assert.equal(claimsByTier(entries, 'measured').length, 0);
  assert.equal(claimsByTier(entries, 'independent').length, 1);
});

const launch = { product: 'iPhone 18 Pro', releaseDate: '2026-09-11' };
const day = (n: number) => new Date(Date.UTC(2026, 8, 11) + n * 24 * 60 * 60 * 1000);

test('a launch piece with no measurement yet says exactly that', () => {
  const status = launchStatus(launch, [makerOnly], day(4));
  assert.equal(status.state, 'awaiting');
  assert.equal(status.daysSinceRelease, 4);
  assert.equal(status.open, true);
  assert.deepEqual(status.measuredBy, []);
});

test('the notice stops waiting the moment a protocol-publishing outlet reports', () => {
  const status = launchStatus(launch, [makerOnly, measuredByGsm], day(6));
  assert.equal(status.state, 'first-result');
  assert.deepEqual(status.measuredBy, ['GSMArena']);
  assert.deepEqual(status.independentBy, ['GSMArena']);
});

test('our own run does not make us the independent result the notice waits for', () => {
  const ourOwn: ClaimData = {
    ...measuredByGsm,
    tier: 'measured',
    attribution: 'SleekDrops',
    value: '9 h 41 min',
  };
  const status = launchStatus(launch, [makerOnly, ourOwn], day(6));
  assert.equal(status.state, 'awaiting', 'a page carrying only our own test is still waiting');
  assert.deepEqual(status.measuredBy, ['SleekDrops']);
  assert.deepEqual(status.independentBy, []);
});

test('past the window the notice stops blaming the calendar', () => {
  const status = launchStatus(launch, [makerOnly], day(LAUNCH_WINDOW_DAYS + 1));
  assert.equal(status.state, 'closed');
  assert.equal(status.open, false);
});

test('a pre-order piece is inside the window too', () => {
  const status = launchStatus(launch, [], day(-10));
  assert.equal(status.state, 'awaiting');
  assert.equal(status.daysSinceRelease, -10);
  assert.equal(status.open, true);
});

test('a release still ahead of us is written in the tense it deserves', () => {
  // The chip beside this sentence reads "Pre-order"; "went on sale on 14
  // October" under it is the notice contradicting itself about the one fact
  // the whole notice is reasoned from.
  assert.equal(
    onSaleSentence('Nova Watch 2', 'October 14, 2026', launchStatus(launch, [], day(-10)).daysSinceRelease),
    'Nova Watch 2 goes on sale on October 14, 2026.',
  );
  assert.equal(
    onSaleSentence('iPhone 18 Pro', 'September 11, 2026', 0),
    'iPhone 18 Pro went on sale on September 11, 2026.',
  );
  assert.equal(
    onSaleSentence('iPhone 18 Pro', 'September 11, 2026', 4),
    'iPhone 18 Pro went on sale on September 11, 2026.',
  );
});

test('the review-unit line names the supplier and what happened to the unit', () => {
  const loan = provenanceCopy({ acquisition: 'loan', supplier: 'Apple Australia', returned: '2026-10' });
  assert.equal(loan.variant, 'loan');
  assert.equal(loan.lead, 'Apple Australia lent us this unit for testing.');
  assert.match(loan.detail, /returned it in Oct 2026/);
  assert.match(loan.detail, /had no input into this page/);
  // "Supplied for review" names nobody and leaves the unit's fate open - the
  // family of vague labels the ACCC's sweep singled out.
  assert.doesNotMatch(`${loan.lead} ${loan.detail}`, /supplied for review/i);
});

test('a bought unit says what we paid, and a missing unit says there was none', () => {
  const bought = provenanceCopy({ acquisition: 'retail', paid: 'A$2,199' });
  assert.equal(bought.variant, 'retail');
  assert.match(bought.lead, /bought this unit at retail for A\$2,199/);

  const desk = provenanceCopy({ acquisition: 'none' });
  assert.equal(desk.variant, 'desk');
  assert.match(desk.lead, /not sent a unit and did not buy one/);
  assert.match(desk.detail, /labelled with who did measure it/);
});

test('the no-unit block does not contradict a figure the page labels as ours', () => {
  // "Nothing on this page is measured by us" printed above a card reading "We
  // measured it" is the page arguing with itself.
  const ours = provenanceCopy({ acquisition: 'none' }, true);
  assert.equal(ours.variant, 'desk');
  assert.match(ours.lead, /not sent a unit and did not buy one/);
  assert.doesNotMatch(ours.detail, /nothing on this page is measured by us/i);
  assert.match(ours.detail, /Where a figure below is ours it says so/);
});

test('a post carrying none of this renders as it always did', () => {
  assert.equal(evidenceState([], []), 'legacy');
  assert.equal(evidenceState([], [{ measured: undefined }]), 'legacy');
});

test('the panel states which case it is in', () => {
  assert.equal(evidenceState(toClaimEntries([makerOnly]), [{ measured: '1,684 nits' }]), 'no-independent-test');
  assert.equal(evidenceState(toClaimEntries([measuredByGsm]), []), 'default');
  assert.equal(
    evidenceState(toClaimEntries([{ ...measuredByGsm, withdrawn: '2,140 nits' }]), []),
    'corrected',
  );
  assert.equal(evidenceState([], [{ measured: '1,684 nits', withdrawn: '2,140 nits' }]), 'corrected');
});

test('a count in a header is the count on screen', () => {
  // A header reading "9 sources" over one visible row is the small lie that
  // costs the whole surface its point.
  assert.equal(shownOfLabel(9, 9), '9 sources');
  assert.equal(shownOfLabel(1, 9), '1 of 9 sources shown');
  assert.equal(shownOfLabel(1, 1), '1 source');
});

test('a citation names where it lands and when that source dated it', () => {
  // "Check it yourself" on its own says nothing about where it goes, which is
  // the link a reader follows to check us. The date rides on the link because
  // how current the figure is is a launch-window reader's actual doubt.
  assert.equal(
    citationLabel(measuredByGsm.attribution, measuredByGsm.date),
    'Check it yourself: GSMArena, Sep 16, 2026',
  );
  assert.equal(citationLabel('Apple'), 'Check it yourself: Apple');
  assert.equal(citationLabel('Apple', undefined, 'Check the claim'), 'Check the claim: Apple');
});

test('a figure points at its own row in the panel, not at the panel', () => {
  const sources = [
    { url: 'https://www.apple.com/au/iphone-18-pro/specs/' },
    { url: 'https://www.gsmarena.com/apple_iphone_18_pro-review.php' },
  ];
  // Our own run has a row of its own, numbered by where the claim sits.
  assert.equal(
    evidenceAnchor({ ...measuredByGsm, tier: 'measured' }, 2, sources),
    `#${claimRowId(2)}`,
  );
  // Everything else lands on the source row it came from - matched on the
  // address a reader reads, so http/https, `www.` and a trailing slash are
  // still one row rather than two.
  assert.equal(
    evidenceAnchor({ ...measuredByGsm, sourceUrl: 'http://gsmarena.com/apple_iphone_18_pro-review.php' }, 0, sources),
    `#${sourceRowId(1)}`,
  );
  assert.equal(claimRowId(0), 'evidence-claim-1');
  assert.equal(sourceRowId(1), 'evidence-source-2');
});

test('a figure whose source is not in the list still lands somewhere', () => {
  // An anchor with no target fails the build, so the fallback is the panel
  // itself rather than a row that may not have been rendered.
  assert.equal(
    evidenceAnchor({ ...makerOnly, sourceUrl: 'https://example.com/elsewhere' }, 0, []),
    `#${EVIDENCE_PANEL_ID}`,
  );
  assert.equal(evidenceAnchor(makerOnly, 0), `#${EVIDENCE_PANEL_ID}`);
});

test('the in-page link does not claim a check nobody made', () => {
  // "How we checked" over a maker's number would be the page claiming a
  // verification it did not do, which is the one thing the tier labels exist
  // to stop.
  assert.equal(methodLinkLabel('measured'), 'How we checked');
  assert.equal(methodLinkLabel('independent'), 'How we checked');
  assert.equal(methodLinkLabel('manufacturer'), 'Where this came from');
  assert.equal(methodLinkLabel('context'), 'Where this came from');
});
