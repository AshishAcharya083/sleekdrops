// The slop detector is the one quality gate that doesn't depend on a model
// agreeing with us, so it has to be right about two things: it catches the
// tells, and it leaves honest product prose alone. A false positive costs a
// revision round on every article that mentions a landscape lens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSlop,
  formatSlopReport,
  proseLines,
  slopSeverity,
  SLOP_PASS_SCORE,
  type CorpusArticle,
} from './slop.js';

/** Rule names hit by a draft, for terse assertions. */
const rules = (md: string): string[] => detectSlop(md).findings.map((f) => f.rule);

test('clean product prose scores full marks', () => {
  const draft = `## Our pick

The Ninja AF160 costs $229 at Amazon Australia and holds 5.7 litres. We put it
first because the basket clears a whole chicken, which the $189 Philips cannot.

Battery life runs to 30 hours with noise cancelling on. Sony quotes 40. Owner
reviews on Amazon put the real number nearer 28 once you play at volume.

### What we would skip

The Kmart 4L unit. It is cheap, and the basket warps above 200C.`;
  const report = detectSlop(draft);
  assert.equal(report.findings.length, 0, `unexpected findings: ${rules(draft).join(', ')}`);
  assert.equal(report.score, 100);
  assert.ok(report.words > 60);
});

test('catches tier-1 AI vocabulary and names the replacement', () => {
  const report = detectSlop('This robust device seamlessly delves into the audio landscape.');
  const found = report.findings.map((f) => f.rule);
  assert.ok(found.some((r) => r.includes('robust')));
  assert.ok(found.some((r) => r.includes('seamlessly')));
  assert.ok(found.some((r) => r.includes('delves')));
  assert.ok(found.some((r) => r.includes('landscape')));
  assert.ok(report.score < SLOP_PASS_SCORE);
  const delve = report.findings.find((f) => f.rule.includes('delves'));
  assert.match(delve!.fix, /looks at/);
  assert.deepEqual(delve!.lines, [1]);
});

test('leaves the literal senses of contextual words alone', () => {
  const draft = `Shoot in landscape mode for the widest frame. The comprehensive warranty
runs three years. Use the app to navigate to the nearest service centre.`;
  assert.deepEqual(rules(draft), []);
});

test('catches banned phrases with their line numbers', () => {
  const draft = `In today's market, buyers want more.

It's worth noting that the battery plays a crucial role here.`;
  const report = detectSlop(draft);
  const phrases = report.findings.filter((f) => f.category === 'banned-phrase');
  assert.equal(phrases.length, 3);
  assert.deepEqual(
    phrases.find((f) => f.rule.includes("today's"))!.lines,
    [1],
  );
  assert.deepEqual(
    phrases.find((f) => f.rule.includes('worth noting'))!.lines,
    [3],
  );
});

test('catches the structural tells', () => {
  const draft = `It's not about the price, it's about the fit.

This is not just a speaker but also a lamp.

The XM6 serves as a good all-rounder, delivering strong bass.`;
  const found = rules(draft);
  assert.ok(found.some((r) => r.includes('Binary contrast')));
  assert.ok(found.some((r) => r.includes('Additive hedge')));
  assert.ok(found.some((r) => r.includes('Copula avoidance')));
});

test('flags false agency and points at the human', () => {
  const report = detectSlop('The data tells us buyers care about battery life.');
  const finding = report.findings.find((f) => f.category === 'false-agency');
  assert.ok(finding);
  assert.match(finding!.fix, /Name the person/);
});

test('hedge adverbs are budgeted by length, not banned outright', () => {
  // Two hedges in a short paragraph sit inside the budget.
  assert.deepEqual(
    detectSlop('The fit is really good. Battery life is simply better than the Bose.').findings,
    [],
  );
  const heavy = detectSlop(
    'It is really simply actually genuinely honestly truly basically fine.',
  );
  const hedge = heavy.findings.find((f) => f.category === 'hedge');
  assert.ok(hedge);
  assert.match(hedge!.fix, /hedge adverbs in \d+ words/);
});

test('em-dash density is budgeted per 1,000 words', () => {
  const one = detectSlop('The Sony wins — battery life is the reason.');
  assert.equal(one.findings.length, 0);
  const many = detectSlop(
    'The Sony wins — battery — comfort — price — noise cancelling — and app support.',
  );
  const dash = many.findings.find((f) => f.rule === 'Em-dash density');
  assert.ok(dash);
  assert.equal(dash!.count, 3); // 5 dashes, budget 2
});

test('metronomic rhythm is flagged, varied rhythm is not', () => {
  const flat = [
    'The Sony headphones sound clean and warm today.',
    'The Bose headphones sound clear and bright today.',
    'The Sennheiser cans sound flat and dull today.',
    'The Apple earbuds sound thin and sharp today.',
    'The Jabra buds sound muddy and weak today.',
  ].join(' ');
  assert.ok(rules(flat).includes('Metronomic sentence rhythm'));

  const varied =
    'The Sony wins. Battery life runs to thirty hours with noise cancelling switched on, ' +
    'which is eight more than the Bose manages on the same test track at the same volume. ' +
    'Comfort is closer. We still picked Sony.';
  assert.ok(!rules(varied).includes('Metronomic sentence rhythm'));
});

test('code fences, tables and link targets are not scanned', () => {
  const draft = `| Model | Where to buy |
| --- | --- |
| Sony XM6 | [Check price] |

\`\`\`
This robust seamless landscape delves into everything.
\`\`\`

Read the [comprehensive guide](/go/robust-seamless-delve) for more.`;
  // "comprehensive guide" is anchor text and does get scanned; the fenced
  // block and the /go/ slug must not be.
  const found = rules(draft);
  assert.deepEqual(found, ['AI vocabulary: "comprehensive" (as a filler adjective)']);
});

test('proseLines preserves line numbering across stripped regions', () => {
  const lines = proseLines('one\n```\nrobust\n```\nfour');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'one');
  assert.equal(lines[2], '');
  assert.equal(lines[4], 'four');
});

test('formatSlopReport is empty for a clean draft and actionable otherwise', () => {
  assert.equal(formatSlopReport(detectSlop('The Ninja costs $229 and holds 5.7 litres.')), '');
  const text = formatSlopReport(detectSlop('This robust solution delves into the problem.'));
  assert.match(text, /Anti-slop scan: \d+\/100/);
  assert.match(text, /\[banned-word\]/);
  assert.match(text, /Fix:/);
});

test('an empty or missing draft does not throw', () => {
  assert.equal(detectSlop('').score, 100);
  assert.equal(detectSlop(undefined as unknown as string).words, 0);
});

test('one banned word is high severity even when the score still passes', () => {
  const report = detectSlop(
    'We delve into basket size below. The Ninja AF160 costs $229 at Amazon Australia and ' +
      'holds 5.7 litres, which is enough for a whole chicken. Sony quotes 40 hours.',
  );
  assert.ok(report.score >= SLOP_PASS_SCORE, 'one word should not tank the score');
  assert.equal(report.findings.length, 1);
  assert.equal(slopSeverity(report.findings[0]), 'high');
});

test('a pile of tier-1 vocabulary fails the score outright', () => {
  const report = detectSlop('This robust device seamlessly delves into the audio landscape.');
  assert.ok(report.score < SLOP_PASS_SCORE, `scored ${report.score}`);
});

test('severity ranks structural tells below vocabulary and rhythm below both', () => {
  const structure = detectSlop("It's not about price, it's about fit.").findings[0];
  assert.equal(slopSeverity(structure), 'medium');
  const rhythm = detectSlop('A — b — c — d — e — f.').findings.find((f) => f.category === 'rhythm');
  assert.equal(slopSeverity(rhythm!), 'low');
});

// ---------------------------------------------------------------------------
// Scanner v2: structure, specificity and cross-corpus repetition
// ---------------------------------------------------------------------------
//
// Both long fixtures below are modelled on what the pipeline actually ships,
// and both are clean on every v1 rule - that is the whole point. TEMPLATED is
// the piece an AdSense reviewer called "markedly more templated and generic":
// no banned word anywhere in it, and every paragraph the same size, every
// section the same shape, and not one number. VARIED is the same subject
// written the way we want it and has to keep scoring 100.

const TEMPLATED = `Finding a cordless stick vacuum in Australia comes down to suction, runtime and
what you are willing to store in a hallway cupboard. The best pick for most
homes is a mid-weight model with a removable battery, because that is the part
that fails first and the part you can replace yourself later on.

## What to look for in a cordless stick vacuum

Choosing a stick vacuum for an Australian home means weighing suction against
runtime and against price. The right model depends on your floors, your storage
space and how often you expect to empty the bin. Most buyers are served well by
a mid-range unit that balances those three things sensibly.

Battery capacity is the first thing to weigh up here. A bigger battery adds
weight to the handle, and that weight is felt within minutes of starting a job
above your head. The trade-off is real for anybody who cleans a two-storey home
in a single session without a break.

## How the cleaning heads compare

The cleaning head is the part that decides how a vacuum feels on the floor you
actually own. A soft roller glides over hard boards and lifts fine dust, while a
stiffer brush bar digs into carpet pile. Buyers with a mix of both surfaces will
want a machine that ships with each.

Head design also shapes how much of the room you can reach. A slimmer head slips
under a lounge and along a skirting board, and a wider one covers open floor in
fewer passes. The choice comes down to the layout of the rooms you clean most
often in your own home.

## Why filtration matters for allergies

The filter stack is what keeps the dust you just picked up from going back into
the room you are standing in. A sealed system holds the fine particles inside
the machine, while a leaky one pushes them out through the motor housing. Homes
with allergy sufferers should treat this as the deciding factor.

Filter upkeep is part of the running cost of any of these machines. A washable
filter needs a rinse every month and a full day to dry before it goes back in,
and a paper one needs replacing on a schedule. Buyers should budget for that
before choosing between the models.

## What we think about price

The price of a stick vacuum tells you less about cleaning power than the badge
on the front would suggest. A mid-priced machine from a serious brand will often
out-clean a flagship from a maker that treats floor care as a sideline. Value
here is about the parts you can still buy in three years.

Warranty length is the other half of the same question for most households. A
longer term signals that the maker expects the motor and the battery to survive
normal use, and a short one signals the opposite. Buyers should read what the
warranty actually covers before they hand over the money.

## FAQ

### How long should a cordless stick vacuum last?

A well-made stick vacuum should give you five to seven years of weekly use
before the motor or the battery gives out. The battery is usually the first
part to fail, so a model with a user-replaceable pack will last longer than one
that has to go back to the maker for service.`;

const VARIED = `Buy the Dyson V15 Detect Absolute. It costs $1,449 RRP in Australia as of March
2026, and it is the only stick vacuum in this group whose dust sensor gave us a
number we could argue with rather than a light that guesses.

## The pick: Dyson V15 Detect Absolute

Dyson rates the V15 at 60 minutes on the eco setting with the fluffy head
attached, which is the figure printed on the box and the figure almost nobody
sees. Owner reviews on Amazon Australia put the realistic number closer to 45
once you switch to the carpet head, and roughly 9 minutes in boost. Neither
figure is a lie; they are answers to different questions, and the box answers
the easier one.

That gap matters more than it sounds. A three-bedroom house takes about 20
minutes of real cleaning, so the eco figure is fine and the boost figure is a
rounding error you will never plan around.

The catch is weight. At 3.1 kg it is the heaviest here, and the 1-star reviews
are almost all about the wrist rather than the suction.

## Cheaper, and nearly as good: Shark Detect Pro

Shark sells the Detect Pro for $599 RRP. It picked up the same spilled flour
from floorboards in the same two passes, and the bin empties without you having
to touch what is inside it.

Where it loses is the head. There is one, and it is a compromise: fine on
boards, average on a thick wool rug.

## Skip the supermarket models

Do not buy a stick vacuum off a supermarket floor stack.

The 2-year warranty usually excludes the battery, which is the part that dies,
and the replacement packs are discontinued within about 18 months of the model
going off sale.

If your budget is under $300, a corded upright will clean better for longer.
That is not a satisfying answer, but it is the honest one.

## How we picked

We started from the 14 models sold through Amazon Australia and the two big
retailers in March 2026, then cut anything without a published air-watt figure
or a user-replaceable battery. That left six.

For the remaining six we read every 1-star and 2-star review published in the
past 12 months, on the theory that a vacuum's real specification is whatever
breaks first. Three complaints came up again and again: clogged filters, bin
seals that split, and batteries that stop holding charge in the second year.

This is editorial synthesis from published specifications, retailer listings
and owner reviews. We have not run these machines through a lab.

## FAQ

### How long does a stick vacuum battery last?

Most packs hold their rated runtime for about 500 charge cycles, which works
out at three to four years of weekly cleaning. Dyson and Shark both sell
replacement packs for the current generation; the supermarket brands generally
do not, which is the whole argument for buying either of them.`;

/** Four H2s, all opening on "The X is …", but of visibly different lengths. */
const SAME_FRAME_SECTIONS = `Buy the Sonos Era 100 if you want one speaker for a small living room. It is
$399 RRP in Australia as of March 2026.

## The Sonos Era 100 is the pick for most rooms

The Era 100 is a 3-driver speaker that Sonos rates at 30 watts, and in a room
under 20 square metres it is the one we would buy. Two tweeters do the stereo
work that the older Sonos One faked with a single driver.

Setup takes about 5 minutes over Wi-Fi.

## The JBL Authentics 200 has the better bass

The Authentics 200 costs $649 RRP and pushes noticeably more low end, which
matters if the room is bigger than about 30 square metres. Owner reviews on
Amazon Australia repeatedly mention the weight, at 3.5 kg, as the reason it
never moves once it is placed.

Its app is worse. Two apps, in fact, and only one of them remembers your Wi-Fi.

## The Marshall Acton III is the one to skip

The Acton III has the look and a $499 RRP. Skip it anyway.

The 1-star reviews from 2025 and 2026 are dominated by one complaint: the
volume knob loses its detents inside about 18 months of daily use, and Marshall
sells no replacement part for it.

## The Yamaha WX-021 is the value pick

The WX-021 sells for $229 RRP, which is the lowest here, and it is the only one
of the four with a physical line-in. It does less, and what it does it keeps
doing: our unit is three years old and still on its first firmware.`;

/** Section every published article carries by instruction, so it is not repetition. */
const HOUSE_METHOD = `## How we picked

We started from every model sold through Amazon Australia in March 2026, then
cut anything without a published spec sheet or a user-replaceable battery.

This is editorial synthesis from published specifications, retailer listings and
owner reviews. We have not run these products through a lab.`;

const published = (slug: string, body: string): CorpusArticle => ({
  slug,
  title: slug,
  body: `${body}\n\n${HOUSE_METHOD}`,
  publishedAt: '2026-03-01',
});

/** Five published articles, every one of them carrying the house methodology. */
const CORPUS: CorpusArticle[] = [
  published(
    'best-portable-bluetooth-speakers',
    `If you want the best portable Bluetooth speaker in Australia right now, buy the
JBL Flip 6. It costs $149 RRP and it is the one we would hand to a friend
without a caveat.

## Why the JBL Flip 6 wins

JBL rates the Flip 6 at 12 hours of playback, and the IP67 rating means a
poolside drop is survivable. The bass is thinner than the Bose equivalent, which
matters indoors and not at all outside.`,
  ),
  published(
    'best-air-fryers',
    `The Ninja AF160 is the air fryer we would buy for a family of four. It holds 5.7
litres and lists at $229 RRP.

## What the basket size actually means

A 5.7 litre basket clears a whole chicken, which the 4 litre Kmart unit cannot.
Ninja quotes 75 minutes at 200C before the coating starts to discolour, and the
owner reviews back that up.`,
  ),
  published(
    'best-robot-vacuums',
    `Buy the Roborock Q7 Max if you want a robot vacuum that empties itself. It is
$899 RRP in Australia and the app is the least annoying of the four we compared.

## Where the Roborock struggles

Dark rugs confuse the cliff sensor on every model here, and the Q7 Max is no
exception. Owners report the same complaint through 2025 and 2026.`,
  ),
  published(
    'best-electric-toothbrushes',
    `The Oral-B iO4 is the electric toothbrush we recommend at $129 RRP. It is the
cheapest brush in the range with a pressure sensor that stops the motor.

## Heads and running costs

Replacement heads run about $12 each and last three months, so budget $48 a year
on top of the brush.`,
  ),
  published(
    'best-coffee-grinders',
    `The Baratza Encore ESP is the grinder to buy at $399 RRP if you pull espresso at
home. Its 40 mm burrs are the same set the older Encore used.

## Grind retention

About 1.5 grams stays in the chute between doses, which is enough to matter for
single-dosing and not enough to matter for anybody else.`,
  ),
];

/** The speakers article's opening and shape, with vacuum nouns dropped in. */
const NEAR_DUPLICATE = `If you want the best cordless stick vacuum in Australia right now, buy the
Dyson V15 Detect. It costs $1,449 RRP and it is the one we would hand to a
friend without a caveat.

## Why the Dyson V15 wins

Dyson rates the V15 at 60 minutes of runtime, and the dust sensor means a
carpeted room is measurable rather than guessed at, which is the single reason
we picked it over the cheaper Shark. The weight is worse.

${HOUSE_METHOD}`;

test('the templated draft is clean on the v1 rules and still fails the v2 gate', () => {
  const report = detectSlop(TEMPLATED);
  const v1 = report.findings.filter(
    (f) => !['uniformity', 'specificity', 'repetition'].includes(f.category),
  );
  assert.deepEqual(v1, [], `v1 rules should be silent: ${v1.map((f) => f.rule).join(', ')}`);
  assert.ok(report.score < SLOP_PASS_SCORE, `scored ${report.score}`);
});

test('the same subject written with variety and specifics still scores 100', () => {
  const report = detectSlop(VARIED);
  assert.deepEqual(report.findings, [], rules(VARIED).join(', '));
  assert.equal(report.score, 100);
});

test('flat sentence-length variance is flagged with the sentences that caused it', () => {
  const finding = detectSlop(TEMPLATED).findings.find(
    (f) => f.rule === 'Flat sentence-length variance',
  );
  assert.ok(finding);
  assert.match(finding.fix, /Sentence lengths vary by only \d+%/);
  assert.ok(finding.lines.length > 0);
  assert.ok(finding.lines.every((line) => line > 0));
  assert.equal(
    detectSlop(VARIED).findings.some((f) => f.rule === 'Flat sentence-length variance'),
    false,
  );
});

test('paragraphs that are all the same size are flagged, varied ones are not', () => {
  const finding = detectSlop(TEMPLATED).findings.find((f) => f.rule === 'Uniform paragraph length');
  assert.ok(finding);
  assert.match(finding.fix, /paragraphs, all about \d+ words/);
  // Anchored at the paragraphs themselves, not at the top of the file.
  assert.ok(finding.lines.some((line) => line > 1));
  assert.equal(
    detectSlop(VARIED).findings.some((f) => f.rule === 'Uniform paragraph length'),
    false,
  );
});

test('section-shape uniformity catches a repeated opening move on its own', () => {
  const finding = detectSlop(SAME_FRAME_SECTIONS).findings.find(
    (f) => f.rule === 'Section-shape uniformity',
  );
  assert.ok(finding);
  assert.match(finding.fix, /3 of 4 sections open with a definition/);
  // Length variance is fine here, so only the frame signal may be reported.
  assert.doesNotMatch(finding.fix, /opening block runs/);
  assert.equal(finding.lines.length, 3);
});

test('the FAQ is exempt from the uniformity metrics', () => {
  // Its answers are 40-60 words each by instruction - the site builds FAQPage
  // schema out of them - so a uniform FAQ must not cost the draft anything.
  const faq = `## FAQ

### How long does a stick vacuum battery last?

Most packs hold their rated runtime for about 500 charge cycles, which works out
at three to four years of weekly cleaning before the pack needs replacing.

### Are the cheap supermarket models worth buying?

No. The 2-year warranty on those models excludes the battery, and replacement
packs are discontinued about 18 months after the model goes off sale.

### Do you need two cleaning heads?

Only if you have both carpet and hard floors. A soft roller lifts fine dust from
boards, and a stiffer brush bar is what digs grit out of a wool pile.`;
  assert.deepEqual(detectSlop(`${VARIED}\n\n${faq}`).findings, []);
});

test('specificity density is measured, and short drafts are left alone', () => {
  const finding = detectSlop(TEMPLATED).findings.find((f) => f.rule === 'Thin specificity density');
  assert.ok(finding);
  assert.match(finding.fix, /0 specifics .* in \d+ words/);
  assert.ok(finding.lines.length > 0, 'anchored at the paragraphs carrying none');
  assert.equal(
    detectSlop(VARIED).findings.some((f) => f.category === 'specificity'),
    false,
  );
  // Under the minimum word count a density read is noise, not a finding.
  const short = 'It is a good speaker for a small room and it sounds fine. '.repeat(4);
  assert.equal(
    detectSlop(short).findings.some((f) => f.category === 'specificity'),
    false,
  );
});

test('a near-duplicate of a published article is caught, phrase by phrase', () => {
  const report = detectSlop(NEAR_DUPLICATE, { corpus: CORPUS });
  const ngram = report.findings.find((f) => f.rule === 'Recycled phrasing from published articles');
  assert.ok(ngram);
  assert.match(ngram.fix, /also appear in "best-portable-bluetooth-speakers"/);
  assert.ok(ngram.matches.some((m) => m.includes('in australia right now buy')));
  assert.ok(ngram.lines.every((line) => line > 0));

  const opening = report.findings.find((f) => f.rule === 'Opening reused from a published article');
  assert.ok(opening);
  assert.match(opening.fix, /share \d+% of their vocabulary with "best-portable-bluetooth-speakers"/);
  assert.deepEqual(opening.lines, [1]);
});

test('an unrelated draft is not flagged, even sharing the house methodology', () => {
  // Every published article carries "How we picked" and the disclaimer by
  // instruction, so those n-grams are furniture, not repetition.
  const withHouseMethod = `${VARIED}\n\n${HOUSE_METHOD}`;
  assert.deepEqual(
    detectSlop(withHouseMethod, { corpus: CORPUS }).findings.filter(
      (f) => f.category === 'repetition',
    ),
    [],
  );
});

test('an article never has to be compared against itself to stay clean', () => {
  // loadPublishedCorpus takes excludeSlug for this, but a caller that forgets
  // should still see why: the same body scanned against itself is a duplicate.
  const self = detectSlop(NEAR_DUPLICATE, { corpus: [published('itself', NEAR_DUPLICATE)] });
  assert.ok(self.findings.some((f) => f.category === 'repetition'));
});

test('omitting the corpus skips the cross-corpus metrics entirely', () => {
  const alone = detectSlop(NEAR_DUPLICATE);
  assert.deepEqual(alone, detectSlop(NEAR_DUPLICATE, {}));
  assert.deepEqual(alone, detectSlop(NEAR_DUPLICATE, { corpus: [] }));
  assert.equal(
    alone.findings.some((f) => f.category === 'repetition'),
    false,
  );
  assert.ok(alone.score > detectSlop(NEAR_DUPLICATE, { corpus: CORPUS }).score);
});

test('no single new metric drags a draft below the pass mark on its own', () => {
  // Each new category's cap is set for this: a draft that is clean on the
  // lexical rules must not be routed back for a revision round by one
  // structural measurement alone.
  const sections = detectSlop(SAME_FRAME_SECTIONS);
  assert.deepEqual(sections.findings.map((f) => f.rule), ['Section-shape uniformity']);
  assert.ok(sections.score >= SLOP_PASS_SCORE, `section shape scored ${sections.score}`);

  const thin = detectSlop(VARIED.replace(/\d/g, 'x'));
  assert.deepEqual(thin.findings.map((f) => f.category), ['specificity']);
  assert.ok(thin.score >= SLOP_PASS_SCORE, `thin specificity scored ${thin.score}`);

  const duplicate = detectSlop(NEAR_DUPLICATE, { corpus: CORPUS });
  assert.deepEqual(duplicate.findings.map((f) => f.category), ['repetition', 'repetition']);
  assert.ok(duplicate.score >= SLOP_PASS_SCORE, `near-duplicate scored ${duplicate.score}`);
});

test('every new finding carries line numbers and a fix, like every old one', () => {
  const findings = [
    ...detectSlop(TEMPLATED).findings,
    ...detectSlop(NEAR_DUPLICATE, { corpus: CORPUS }).findings,
  ];
  const v2 = findings.filter((f) =>
    ['uniformity', 'specificity', 'repetition'].includes(f.category),
  );
  assert.ok(v2.length >= 4, `expected the v2 metrics to fire: ${v2.map((f) => f.rule).join(', ')}`);
  for (const finding of v2) {
    assert.ok(finding.lines.length > 0, `${finding.rule} has no line numbers`);
    assert.ok(finding.lines.every((line) => Number.isInteger(line) && line > 0));
    assert.ok(finding.fix.length > 20, `${finding.rule} has no usable fix`);
    assert.notEqual(slopSeverity(finding), 'high', `${finding.rule} must never force a round`);
  }
});

test('a banned word still outranks every v2 finding in the issue list', () => {
  // The reviewer only files the first few findings as issues, and a banned
  // word is the one that must never fall off the end of that list.
  const report = detectSlop(`We delve into the numbers below.\n\n${TEMPLATED}`);
  assert.match(report.findings[0].rule, /delve/);
});

test('the scan stays fast enough to run on every review round', () => {
  const corpus = Array.from({ length: 30 }, (_, i) => published(`published-${i}`, TEMPLATED));
  const draft = `${TEMPLATED}\n\n${VARIED}`;
  const started = performance.now();
  detectSlop(draft, { corpus });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)}ms against 30 published articles`);
});

test('phrasing the whole site shares is flagged once it outgrows the furniture', () => {
  // The disclaimer and the CTA lines are required, so a draft is allowed to
  // carry them. A draft that is mostly house frames is not carrying furniture,
  // it is the site-wide sameness the AdSense review actually described.
  const STOCK_FRAME = `Before we get to the picks, a word on how this guide is put together and what
it is for. We look at what the makers publish, what the retailers list on the
day of writing, and what owners say went wrong after the first six months. We
do not accept review units, we do not rank by commission, and we say plainly
when the cheaper option is the one to buy. Prices move constantly in Australia,
so treat every figure here as the recommended price rather than the shelf price.`;

  const houseCorpus = CORPUS.map((doc) => ({ ...doc, body: `${doc.body}\n\n${STOCK_FRAME}` }));
  const draft = `${VARIED}\n\n${STOCK_FRAME}`;

  const finding = detectSlop(draft, { corpus: houseCorpus }).findings.find(
    (f) => f.rule === 'House phrasing repeated site-wide',
  );
  assert.ok(finding);
  assert.match(finding.fix, /appear in most of the last 5 published articles/);
  assert.ok(finding.lines.every((line) => line > 0));

  // The methodology block on its own stays inside the allowance.
  assert.equal(
    detectSlop(`${VARIED}\n\n${HOUSE_METHOD}`, { corpus: CORPUS }).findings.some(
      (f) => f.rule === 'House phrasing repeated site-wide',
    ),
    false,
  );
});

test('a draft with no paragraphs at all still gets a finding it can act on', () => {
  const rows = Array.from(
    { length: 30 },
    () => '| A machine | a long description of what the machine does | and a note |',
  ).join('\n');
  const tableOnly = `## Comparison\n\n| Model | What it is | Notes |\n| --- | --- | --- |\n${rows}`;
  const finding = detectSlop(tableOnly).findings.find((f) => f.category === 'specificity');
  assert.ok(finding);
  assert.deepEqual(finding.lines, [1]);
});
