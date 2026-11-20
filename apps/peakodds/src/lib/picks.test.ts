import { test } from 'node:test';
import assert from 'node:assert/strict';
import { picksIn, splitPreviewBody, type PreviewSegment } from './picks.ts';

const ODDS_AS_AT = new Date('2026-11-18T11:40:00Z');
const HEADER = '| Market | Selection | Indicative odds (decimal) | As at |\n| --- | --- | --- | --- |';

function picksTable(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

function body(table: string): string {
  return [
    '## The short version',
    '',
    '- Harbour City host Ridgeway United.',
    '',
    '## The picks',
    '',
    table,
    '',
    '## Team news and form',
    '',
    'Harbour City name an unchanged side.',
    '',
    '## Why Harbour City',
    '',
    'Seven home wins from eight.',
    '',
    'A set piece is what would beat it.',
    '',
    '## Why under 2.5 goals',
    '',
    'Ridgeway United have gone under in five of six.',
    '',
    '## Verdict',
    '',
    'A narrow home win is the most likely shape.',
    '',
    '<!-- compliance-footer -->',
    '**18+ only.** Help is available.',
    '<!-- /compliance-footer -->',
  ].join('\n');
}

const RECOGNISED_TABLE = picksTable(
  '| Match result | Harbour City | 2.10 | 2026-11-18 22:40 AEDT |',
  '| Total goals | Under 2.5 | 1.85 | 2026-11-18 22:40 AEDT |',
);

function markdownOf(segments: readonly PreviewSegment[]): string {
  return segments.flatMap((segment) => (segment.kind === 'markdown' ? [segment.markdown] : [])).join('\n\n');
}

test('a picks table becomes numbered picks, each carrying its matching Why section as reasoning', () => {
  const segments = splitPreviewBody({ body: body(RECOGNISED_TABLE), oddsAsAt: ODDS_AS_AT });

  assert.deepEqual(picksIn(segments), [
    {
      number: 1,
      market: 'Match result',
      selection: 'Harbour City',
      odds: 2.1,
      reasoning: 'Seven home wins from eight.\n\nA set piece is what would beat it.',
    },
    { number: 2, market: 'Total goals', selection: 'Under 2.5', odds: 1.85, reasoning: null },
  ]);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ['markdown', 'picks', 'markdown', 'verdict', 'markdown'],
  );
  const markdown = markdownOf(segments);
  assert.doesNotMatch(markdown, /Why Harbour City|Seven home wins/);
  assert.match(markdown, /## Why under 2\.5 goals\n\nRidgeway United have gone under/);
  assert.doesNotMatch(markdown, /\| Market \|/);
});

test('a Why heading matches its selection whatever its case', () => {
  const segments = splitPreviewBody({
    body: [picksTable('| Total goals | Under 2.5 | 1.85 | 2026-11-18 22:40 AEDT |'), '', '## WHY under 2.5', '', 'Low scoring.'].join('\n'),
    oddsAsAt: ODDS_AS_AT,
  });
  assert.equal(picksIn(segments)[0].reasoning, 'Low scoring.');
  assert.equal(markdownOf(segments), '');
});

test('the verdict is split out and stops before the appended edition footer', () => {
  const segments = splitPreviewBody({ body: body(RECOGNISED_TABLE), oddsAsAt: ODDS_AS_AT });
  const verdict = segments.find((segment) => segment.kind === 'verdict');
  assert.deepEqual(verdict, { kind: 'verdict', markdown: 'A narrow home win is the most likely shape.' });
  assert.match(markdownOf(segments), /## Verdict/);
  assert.match(markdownOf(segments), /<!-- compliance-footer -->\n\*\*18\+ only\.\*\*/);
});

const FALLBACKS: ReadonlyArray<{ readonly name: string; readonly table: string; readonly oddsAsAt?: Date | null }> = [
  {
    name: 'a header with another column name',
    table: [
      '| Market | Selection | Odds | As at |',
      '| --- | --- | --- | --- |',
      '| Match result | Harbour City | 2.10 | 2026-11-18 22:40 AEDT |',
    ].join('\n'),
  },
  {
    name: 'a price written in words',
    table: picksTable(
      '| Match result | Harbour City | 2.10 | 2026-11-18 22:40 AEDT |',
      '| Both teams to score | No | Evens | 2026-11-18 22:44 AEDT |',
    ),
  },
  { name: 'a price of exactly 1', table: picksTable('| Match result | Harbour City | 1.00 | 2026-11-18 22:40 AEDT |') },
  { name: 'a price below 1', table: picksTable('| Match result | Harbour City | 0.85 | 2026-11-18 22:40 AEDT |') },
  { name: 'a price with three decimals', table: picksTable('| Match result | Harbour City | 2.105 | 2026-11-18 22:40 AEDT |') },
  { name: 'a fractional price', table: picksTable('| Match result | Harbour City | 11/10 | 2026-11-18 22:40 AEDT |') },
  { name: 'a row missing a cell', table: picksTable('| Match result | Harbour City | 2.10 |') },
  { name: 'a row with an extra cell', table: picksTable('| Match result | Harbour City | 2.10 | 22:40 AEDT | Bet365 |') },
  { name: 'an empty selection', table: picksTable('| Match result |  | 2.10 | 2026-11-18 22:40 AEDT |') },
  { name: 'an empty market', table: picksTable('|  | Harbour City | 2.10 | 2026-11-18 22:40 AEDT |') },
  { name: 'a header with no rows', table: HEADER },
  { name: 'a post with no odds as-at time', table: RECOGNISED_TABLE, oddsAsAt: null },
];

for (const { name, table, oddsAsAt = ODDS_AS_AT } of FALLBACKS) {
  test(`${name} leaves the whole table, and every Why section, in the markdown`, () => {
    const segments = splitPreviewBody({ body: body(table), oddsAsAt });
    assert.deepEqual(picksIn(segments), []);
    const markdown = markdownOf(segments);
    assert.ok(markdown.includes(table), 'the table is kept as the writer wrote it');
    assert.match(markdown, /## Why Harbour City\n\nSeven home wins/);
  });
}

test('a recognised picks table leaves other tables in the body untouched', () => {
  const formTable = '| Team | Last five |\n| --- | --- |\n| Harbour City | WWWLW |';
  const segments = splitPreviewBody({ body: `${formTable}\n\n${RECOGNISED_TABLE}`, oddsAsAt: ODDS_AS_AT });
  assert.equal(picksIn(segments).length, 2);
  assert.deepEqual(segments[0], { kind: 'markdown', markdown: formTable });
});

test('a picks table inside a fenced code block stays code', () => {
  const fenced = ['```', RECOGNISED_TABLE, '```'].join('\n');
  const segments = splitPreviewBody({ body: fenced, oddsAsAt: ODDS_AS_AT });
  assert.deepEqual(segments, [{ kind: 'markdown', markdown: fenced }]);
});
