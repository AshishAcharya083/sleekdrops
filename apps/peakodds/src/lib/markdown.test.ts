import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

test('a GitHub-flavoured picks table renders as an HTML table', async () => {
  const html = await renderMarkdown(
    [
      '## Picks',
      '',
      '| Market | Selection | Indicative odds (decimal) | As at |',
      '| --- | --- | --- | --- |',
      '| Head to head | Swans | 1.85 | 16 Jul 2026, 11:00 AEST |',
    ].join('\n'),
  );
  assert.match(html, /<h2[^>]*>Picks<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Indicative odds \(decimal\)<\/th>/);
  assert.match(html, /<td>1\.85<\/td>/);
});
