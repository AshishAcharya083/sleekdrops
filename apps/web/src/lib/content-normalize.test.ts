import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeArticleBody } from './content-normalize.mjs';

test('article body H1 headings are downgraded beneath the page H1', () => {
  assert.equal(normalizeArticleBody('# Title\n\n## Section'), '## Title\n\n## Section');
});

test('heading-like text in fenced code is unchanged', () => {
  const body = '```md\n# Example\n```\n# Real heading';
  assert.equal(normalizeArticleBody(body), '```md\n# Example\n```\n## Real heading');
});

test('a retired official source URL is replaced with its current official page', () => {
  const stale = 'https://www.soundcore.com/au/products/soundcore-2';
  const current = 'https://www.soundcore.com/products/soundcore-2';

  assert.equal(normalizeArticleBody(`[Soundcore 2](${stale})`), `[Soundcore 2](${current})`);
});
