import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendComplianceFooter,
  blockedDomainsIn,
  complianceProblems,
  parseAsAt,
  previewOddsAsAt,
  stripComplianceFooter,
} from './compliance.js';
import type { ComplianceContext } from './compliance.js';
import { peakoddsSeed } from '../platform/peakodds/index.js';
import { AU_FOOTER, GLOBAL_FOOTER } from '../platform/peakodds/footers.js';

function peakodds(editionId: 'au' | 'global'): ComplianceContext {
  const edition = peakoddsSeed.editions.find((e) => e.id === editionId)!;
  return { platform: peakoddsSeed.platform, edition };
}

/** SleekDrops as contract section 2 seeds it: no blocked domains, AUD, an empty footer. */
const sleekdrops: ComplianceContext = {
  platform: { id: 'sleekdrops', name: 'SleekDrops', blockedLinkDomains: [] },
  edition: { complianceFooter: '', currency: 'AUD' },
};

const NOW = new Date('2026-10-03T06:00:00Z');

function preview(table: string): string {
  return `- Swans v Lions, Saturday 4 October, 19:30 AEST.
- The Lions have lost their first-choice ruck.
- The lean: Swans at the line.

## The picks

${table}

## Why the Swans at the line

Their midfield won the contested ball by 18 in the last meeting.[1]

## Verdict

A lean, not a certainty: the Swans' pressure game suits a ruck-less Lions side, and the prices are subject to change.`;
}

const GOOD_TABLE = `| Market | Selection | Indicative odds (decimal) | As at |
| --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | 2026-10-03 14:00 AEST |
| Head to head | Swans | 1.65 | 2026-10-03 02:30 UTC |`;

// ------------------------------------------------------------------ footer

test('the AU footer is appended to an Australian article', () => {
  const body = appendComplianceFooter('## Verdict\n\nA lean.', peakodds('au').edition);
  assert.ok(body.startsWith('## Verdict\n\nA lean.\n\n'));
  assert.ok(body.includes(AU_FOOTER));
  assert.match(body, /1800 858 858/);
  assert.match(body, /betstop\.gov\.au/);
  assert.ok(!body.includes('GamCare'));
});

test('the Global footer is appended to a Global article', () => {
  const body = appendComplianceFooter('## Verdict\n\nA lean.', peakodds('global').edition);
  assert.ok(body.includes(GLOBAL_FOOTER));
  assert.match(body, /18\+ \(21\+ where local law requires\)/);
  assert.match(body, /check your local law/);
  assert.match(body, /0808 8020 133/);
  assert.match(body, /1-800-GAMBLER/);
  assert.match(body, /0800 654 655/);
  assert.ok(!body.includes('1800 858 858'));
});

test('re-assembly replaces the footer rather than stacking a second', () => {
  const edition = peakodds('au').edition;
  const once = appendComplianceFooter('Body.', edition);
  assert.equal(appendComplianceFooter(once, edition), once);
  // The marker comments can be lost in an edit pass; the verbatim text is still recognised.
  const unmarked = once.replace(/<!-- \/?compliance-footer -->\n/g, '');
  assert.equal(appendComplianceFooter(unmarked, edition), once);
});

test('stripping the footer from mid-body keeps the paragraphs around it apart', () => {
  const edition = peakodds('au').edition;
  const assembled = appendComplianceFooter('Before.', edition);
  assert.equal(stripComplianceFooter(`${assembled}After.`, edition).replace(/\n+$/, ''), 'Before.\n\nAfter.');
});

test('an edition with no footer gets its body back byte for byte', () => {
  const body = 'Body with trailing space  \n\n\n';
  assert.equal(appendComplianceFooter(body, sleekdrops.edition), body);
});

test('the appended footer never fails the check it follows', () => {
  for (const id of ['au', 'global'] as const) {
    const ctx = peakodds(id);
    const body = appendComplianceFooter(preview(GOOD_TABLE), ctx.edition);
    assert.deepEqual(complianceProblems(body, ctx, { postType: 'preview', now: NOW }), [], id);
  }
});

// ------------------------------------------------------------------ domains

test('a bookmaker link is rejected', () => {
  const body = 'Compare the line [here](https://www.sportsbet.com.au/betting/australian-rules).';
  const problems = complianceProblems(body, peakodds('au'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /blocked domain on PeakOdds: sportsbet\.com\.au/);
});

test('a bookmaker named by bare host or subdomain is rejected too', () => {
  const blocked = peakoddsSeed.platform.blockedLinkDomains;
  assert.deepEqual(blockedDomainsIn('Prices at bet365.com and m.ladbrokes.com.au.', blocked), [
    'bet365.com',
    'ladbrokes.com.au',
  ]);
  assert.deepEqual(blockedDomainsIn('https://sportsbook.draftkings.com/leagues/football/nfl', blocked), [
    'draftkings.com',
  ]);
});

test('odds-comparison, news and support sites are not blocked', () => {
  const body =
    'Prices via [Oddschecker](https://www.oddschecker.com) and odds.com.au, team news from afl.com.au and theguardian.com. Support: gamblinghelponline.org.au.';
  assert.deepEqual(blockedDomainsIn(body, peakoddsSeed.platform.blockedLinkDomains), []);
});

test('a lookalike host is not mistaken for a blocked one', () => {
  assert.deepEqual(blockedDomainsIn('notsportsbet.com.au and tab.com.au.example.org', ['sportsbet.com.au']), []);
});

test('a bookmaker page cited as a source is rejected', () => {
  const problems = complianceProblems('Clean body.', peakodds('au'), {
    sourceUrls: ['https://www.afl.com.au/news', 'https://www.tab.com.au/sports/betting/AFL'],
  });
  assert.deepEqual(problems, ['cites a blocked domain as a source: tab.com.au']);
});

// ------------------------------------------------------------------ phrases

test('certainty language is rejected', () => {
  const problems = complianceProblems(
    "The Swans are a lock of the round and a guaranteed winner. Call it a dead cert - you can't go wrong.",
    peakodds('global'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^certainty language: /);
  assert.match(problems[0], /lock of the round/);
  assert.match(problems[0], /guaranteed/);
  assert.match(problems[0], /dead cert/);
  assert.match(problems[0], /you can't go wrong/);
});

test('a negated certainty phrase is the responsible copy the rules ask for', () => {
  const body = 'No result is guaranteed, and no bet is risk-free. The Swans are not certain to win.';
  assert.deepEqual(complianceProblems(body, peakodds('au')), []);
});

test('a negation earlier in the clause does not excuse a certainty phrase', () => {
  for (const body of [
    'No doubt about it: the Swans are a sure thing.',
    'Nothing can stop them - a guaranteed winner.',
    "You won't find a better bet: risk-free.",
    'No question, this is a lock.',
    'This is not a sure thing, but a sure thing it is.',
    'There is no doubt the Swans are certain to win.',
  ]) {
    const problems = complianceProblems(body, peakodds('au'));
    assert.equal(problems.length, 1, body);
    assert.match(problems[0], /^certainty language: /, body);
  }
});

test('a negation that governs the phrase is still the responsible copy', () => {
  const body =
    "There is no such thing as a sure thing. No bet is ever risk-free, this pick isn't a lock, and a price is never guaranteed to win. " +
    'Nothing is guaranteed to win, and nobody can make money from betting.';
  assert.deepEqual(complianceProblems(body, peakodds('global')), []);
});

test('every common certainty form is rejected, bare or in a phrase', () => {
  for (const body of [
    'The Swans are a certainty.',
    'Swans are a cert.',
    'The Swans are the certainty of the round.',
    'This one is nailed on.',
    'Absolutely guaranteed.',
    'Guaranteed.',
    'We guarantee a win here.',
    "It's guaranteed the Swans win.",
    "They can't lose this.",
    'Swans cannot lose tonight.',
    'A sure-fire winner.',
    'Bet the house on the Swans.',
  ]) {
    const problems = complianceProblems(body, peakodds('au'));
    assert.equal(problems.length, 1, body);
    assert.match(problems[0], /^certainty language: /, body);
  }
});

test('a hedge the same clause takes back is still certainty language', () => {
  for (const body of [
    'Not a sure thing, but close.',
    "It's not a lock, but it's as near as you'll get.",
    'Nothing is guaranteed to win - but this is almost.',
    'Not a certainty, yet pretty close.',
    'Not guaranteed to win, but close enough.',
  ]) {
    const problems = complianceProblems(body, peakodds('au'));
    assert.equal(problems.length, 1, body);
    assert.match(problems[0], /^certainty language: /, body);
  }
  for (const body of [
    'Not a sure thing, but close games have suited the Swans.',
    'Not a lock, but nearly every metric favours the Swans.',
  ]) {
    assert.deepEqual(complianceProblems(body, peakodds('au')), [], body);
  }
});

test('hedge copy the rules ask for passes', () => {
  for (const body of [
    'No bet is ever a sure thing.',
    'There is never such a thing as a sure thing in footy.',
    'A lean, not a certainty.',
    'There is no certainty in finals footy, and nothing is nailed on.',
    "We can't say with any certainty, and nothing is guaranteed.",
    "Don't bet the house on anything.",
  ]) {
    assert.deepEqual(complianceProblems(body, peakodds('au')), [], body);
  }
});

test('every common bonus and sign-up form is rejected', () => {
  for (const body of [
    'Claim your bonus.',
    'Bonus offer available.',
    'a 200% bonus',
    'Grab a bonus at your favourite book.',
    'Get a bet refund if your team loses.',
    'Get your money refunded if the Swans lose.',
    'Join today and get $50.',
    'Sign up now.',
  ]) {
    const problems = complianceProblems(body, peakodds('au'));
    assert.equal(problems.length, 1, body);
    assert.match(problems[0], /^inducement terms: /, body);
  }
});

test('inducement terms are rejected', () => {
  const problems = complianceProblems(
    'New customers get bonus bets with a deposit match - use promo code PEAK for an odds boost.',
    peakodds('au'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^inducement terms: /);
  for (const term of ['bonus bets', 'deposit match', 'promo code', 'odds boost']) {
    assert.ok(problems[0].includes(term), `${term} not caught`);
  }
});

test('betting framed as income and unit stakes are rejected', () => {
  const problems = complianceProblems(
    'Treat this as a side hustle and make steady money from betting. Stake 2 units on the Swans.',
    peakodds('au'),
  );
  assert.ok(problems.some((p) => p.startsWith('betting framed as income: ')), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('staking advice: ')), problems.join('\n'));
});

test('unit stakes and a tipster banker are rejected in any form', () => {
  for (const body of [
    'Put 1.5u on the Swans at the line.',
    'Swans -12.5 (2 units).',
    'The Swans are our banker of the round.',
    'My banker bet is the Lions.',
  ]) {
    assert.equal(complianceProblems(body, peakodds('au')).length, 1, body);
  }
});

test('ordinary sports copy is not caught by the phrase rules', () => {
  const body =
    'The Bulldogs can still make the top four. Their defensive unit held Carlton to 52 points, and the title race is open; a bonus point is on offer for four tries. ' +
    "A win guarantees Sydney a home final, and they can't lose another game if they want the double chance. " +
    'He has won 2 U.S. Opens, the club has 3 units left in the squad, and Commonwealth Bank bankers say the stadium deal is done. ' +
    'His $2m signing bonus was an added bonus for the club, a bonus-point win keeps them top, they have the certainty of a home final and the certainty of making the eight. ' +
    "Heeney will join today's session, fans get refunds if the match is washed out, and the club will sign up the youngster.";
  assert.deepEqual(complianceProblems(body, peakodds('au')), []);
});

test('a bookmaker named by brand alone is rejected', () => {
  const problems = complianceProblems('Sportsbet has the Swans at 1.90 - get on at Sportsbet.', peakodds('au'));
  assert.deepEqual(problems, ['names a bookmaker: "Sportsbet" (bookmaker)']);
  for (const body of ['The TAB has them at 2.10.', 'DraftKings and William Hill both lean Kansas City.', 'Odds via Paddy-Power.']) {
    assert.equal(complianceProblems(body, peakodds('global')).length, 1, body);
  }
});

test('a sponsored venue or competition name, or a lowercase tab, is not a bookmaker named', () => {
  const body =
    'Stoke host Leeds at the bet365 Stadium in the Sky Bet Championship. Keep a browser tab open for team news.';
  assert.deepEqual(complianceProblems(body, peakodds('global')), []);
});

test('SleekDrops carries no phrase rules and blocks no domain', () => {
  const body = 'Use promo code SAVE10 at checkout - guaranteed lowest price at sportsbet.com.au, A$49.';
  assert.deepEqual(complianceProblems(body, sleekdrops), []);
});

test('the Global edition quotes no currency amount; Australia may', () => {
  const body = 'The winner takes home $3.6 million, and the runner-up £1m. Tickets cost 40 euros.';
  const problems = complianceProblems(body, peakodds('global'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /edition with no currency: "\$3.6 million", "£1m", "40 euros"/);
  assert.deepEqual(complianceProblems(body, peakodds('au')), []);
  assert.match(complianceProblems('A $50 bet returns $92.50.', peakodds('global'))[0], /"\$50", "\$92.50"$/);
  assert.deepEqual(complianceProblems('He fights at 155 pounds.', peakodds('global')), []);
});

// ------------------------------------------------------------------ preview table

test('a well-formed preview passes', () => {
  assert.deepEqual(complianceProblems(preview(GOOD_TABLE), peakodds('au'), { postType: 'preview', now: NOW }), []);
});

test('a preview without a picks table is rejected', () => {
  const problems = complianceProblems(preview('No table here.'), peakodds('au'), { postType: 'preview', now: NOW });
  assert.deepEqual(problems, [
    'a preview needs a picks table with exactly the columns Market | Selection | Indicative odds (decimal) | As at',
  ]);
});

test('a bookmaker column in the picks table is rejected', () => {
  const table = `| Market | Selection | Indicative odds (decimal) | As at | Bookmaker |
| --- | --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | 2026-10-03 14:00 AEST | Example Bet |`;
  const problems = complianceProblems(preview(table), peakodds('au'), { postType: 'preview', now: NOW });
  assert.ok(problems.includes('a table carries a forbidden column: "Bookmaker"'), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('the picks table has the columns ')), problems.join('\n'));
});

test('a stake column is rejected even beside the right four', () => {
  const table = `| Market | Selection | Indicative odds (decimal) | As at | Stake |
| --- | --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | 2026-10-03 14:00 AEST | 1 |`;
  const problems = complianceProblems(preview(table), peakodds('au'), { postType: 'preview', now: NOW });
  assert.ok(problems.includes('a table carries a forbidden column: "Stake"'), problems.join('\n'));
});

test('the picks table columns must be exactly the four, in order', () => {
  const table = `| Selection | Market | Odds | As at |
| --- | --- | --- | --- |
| Swans -6.5 | Line | 1.90 | 2026-10-03 14:00 AEST |`;
  const problems = complianceProblems(preview(table), peakodds('au'), { postType: 'preview', now: NOW });
  assert.deepEqual(problems, [
    'the picks table has the columns Selection | Market | Odds | As at; it must have exactly Market | Selection | Indicative odds (decimal) | As at',
  ]);
});

test('odds must be decimal and every price needs a zoned As at time', () => {
  const table = `| Market | Selection | Indicative odds (decimal) | As at |
| --- | --- | --- | --- |
| Line | Swans -6.5 | 9/10 | 2026-10-03 14:00 AEST |
| Head to head | Swans | -150 | 2026-10-03 14:00 |
| Total | Over 160.5 | $1.85 | yesterday |
| First goal | Heeney | 1.00 | 2026-10-03 04:00 UTC |`;
  const problems = complianceProblems(preview(table), peakodds('au'), { postType: 'preview', now: NOW });
  assert.deepEqual(problems, [
    'picks table row 1: "9/10" is not a decimal price (e.g. 1.85)',
    'picks table row 2: "-150" is not a decimal price (e.g. 1.85)',
    'picks table row 2: "2026-10-03 14:00" is not an As at time with an explicit zone (e.g. 2026-10-03 14:00 AEST)',
    'picks table row 3: "$1.85" is not a decimal price (e.g. 1.85)',
    'picks table row 3: "yesterday" is not an As at time with an explicit zone (e.g. 2026-10-03 14:00 AEST)',
    'picks table row 4: "1.00" is not a decimal price (e.g. 1.85)',
  ]);
});

test('a price seen in the future is rejected', () => {
  const table = `| Market | Selection | Indicative odds (decimal) | As at |
| --- | --- | --- | --- |
| Line | Swans -6.5 | 1.90 | 2026-10-04 14:00 AEST |`;
  const problems = complianceProblems(preview(table), peakodds('au'), { postType: 'preview', now: NOW });
  assert.deepEqual(problems, ['picks table row 1: the As at time "2026-10-04 14:00 AEST" is in the future']);
});

test('the picks table is only required of a preview', () => {
  assert.deepEqual(complianceProblems('An explainer with no table.', peakodds('au'), { postType: 'article' }), []);
});

// ------------------------------------------------------------------ As at

test('As at times parse with every explicit zone form', () => {
  const expected = '2026-10-03T04:00:00.000Z';
  for (const cell of [
    '2026-10-03 14:00 AEST',
    '2026-10-03 15:00 AEDT',
    '2026-10-03 04:00 UTC',
    '2026-10-03 04:00 GMT',
    '2026-10-03T04:00Z',
    '2026-10-03 14:00 UTC+10',
    '2026-10-03 14:00 UTC+10:00',
    '2026-10-03 14:00 +10:00',
    '2026-10-02 23:00 UTC-5',
  ]) {
    assert.equal(parseAsAt(cell)?.toISOString(), expected, cell);
  }
  for (const cell of ['2026-10-03 14:00', '2026-02-31 14:00 UTC', '2026-10-03 25:00 UTC', '2026-10-03 14:00 PST', '']) {
    assert.equal(parseAsAt(cell), null, cell);
  }
});

test('odds_as_at is the oldest As at in the picks table', () => {
  assert.equal(previewOddsAsAt(preview(GOOD_TABLE)), '2026-10-03T02:30:00.000Z');
  assert.equal(previewOddsAsAt('No table.'), null);
});
