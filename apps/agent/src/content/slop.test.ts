// The slop detector is the one quality gate that doesn't depend on a model
// agreeing with us, so it has to be right about two things: it catches the
// tells, and it leaves honest product prose alone. A false positive costs a
// revision round on every article that mentions a landscape lens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSlop, formatSlopReport, proseLines, slopSeverity, SLOP_PASS_SCORE } from './slop.js';

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
