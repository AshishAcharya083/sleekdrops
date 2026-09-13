// The visible sources block is only worth as much as its derivation: the list
// a reader sees has to be the dossier's own sources, in the dossier's order,
// with nothing invented and nothing silently upgraded.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  articleSources,
  citedSourceIndexes,
  numberedSourceList,
  stripUnresolvedCitations,
  type DossierFact,
} from './sources.js';

const fact = (overrides: Partial<DossierFact>): DossierFact => ({
  fact: 'Sticks lose suction as the filter clogs.',
  sourceUrl: 'https://www.choice.com.au/vacuums',
  ...overrides,
});

test('sources are deduped by URL in first-seen order, web schemes only', () => {
  const sources = articleSources([
    fact({ sourceUrl: 'https://www.choice.com.au/vacuums' }),
    fact({ sourceUrl: 'https://www.productreview.com.au/shark' }),
    fact({ sourceUrl: 'https://www.choice.com.au/vacuums' }),
    fact({ sourceUrl: 'not a url' }),
    fact({ sourceUrl: 'javascript:alert(1)' }),
    fact({ sourceUrl: '   ' }),
  ]);

  assert.deepEqual(sources, [
    { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
    { url: 'https://www.productreview.com.au/shark', publisher: 'productreview.com.au' },
  ]);
});

test('a URL is stored as the parser normalised it, not as the research stated it', () => {
  // Source URLs come off search results, so they are untrusted text that ends
  // up inside the page's <script type="application/ld+json"> block.
  const sources = articleSources([
    fact({ sourceUrl: 'https://evil.example/a</script><script>alert(1)</script>' }),
    fact({ sourceUrl: 'https://WWW.Choice.com.au/vacuums' }),
    fact({ sourceUrl: 'https://www.choice.com.au/vacuums' }),
  ]);

  assert.deepEqual(sources, [
    {
      url: 'https://evil.example/a%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E',
      publisher: 'evil.example',
    },
    { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
  ]);
});

test('the publisher is the researcher\'s name for it, else the hostname', () => {
  const sources = articleSources([
    fact({ sourceUrl: 'https://www.rtings.com/headphones', publisher: 'RTINGS' }),
    fact({ sourceUrl: 'https://www.choice.com.au/vacuums', publisher: '   ' }),
    fact({ sourceUrl: 'https://sony.com.au/wh1000xm6', publisher: null }),
  ]);

  assert.deepEqual(
    sources.map((s) => s.publisher),
    ['RTINGS', 'choice.com.au', 'sony.com.au'],
  );
});

test('the date rides through at the precision the source published it', () => {
  const sources = articleSources([
    fact({ sourceUrl: 'https://a.example/1', date: '2026-09-04' }),
    fact({ sourceUrl: 'https://a.example/2', date: '2026-09' }),
    fact({ sourceUrl: 'https://a.example/3', date: '2026' }),
    fact({ sourceUrl: 'https://a.example/4', date: null }),
    fact({ sourceUrl: 'https://a.example/5', date: 'last spring' }),
  ]);

  assert.deepEqual(
    sources.map((s) => s.date),
    ['2026-09-04', '2026-09', '2026', undefined, undefined],
  );
});

test('an unattributed source keeps the unknown tier rather than being promoted', () => {
  const sources = articleSources([
    fact({ sourceUrl: 'https://sony.com.au/spec', tier: 'primary' }),
    fact({ sourceUrl: 'https://forum.example/thread', tier: 'unknown' }),
    fact({ sourceUrl: 'https://blog.example/post', tier: 'made-up' as never }),
  ]);

  assert.deepEqual(
    sources.map((s) => s.tier),
    ['primary', 'unknown', undefined],
  );
});

test('the writer is handed the numbering the published page will show', () => {
  const sources = articleSources([
    fact({ sourceUrl: 'https://www.choice.com.au/vacuums', publisher: 'Choice', date: '2026-03', tier: 'expert' }),
    fact({ sourceUrl: 'https://sony.com.au/spec' }),
  ]);

  assert.equal(
    numberedSourceList(sources),
    '[1] Choice (2026-03) - expert source - https://www.choice.com.au/vacuums\n' +
      '[2] sony.com.au - https://sony.com.au/spec',
  );
});

test('a marker pointing past the end of the list is stripped, with its space', () => {
  const body = 'Choice measured 210AW in 2026.[1] Owners disagree.[4] Sony says 30 hours.[2]';

  assert.equal(
    stripUnresolvedCitations(body, 2),
    'Choice measured 210AW in 2026.[1] Owners disagree. Sony says 30 hours.[2]',
  );
});

test('markdown links and link references are not citation markers', () => {
  const body = '[Shark Detect Pro](/go/shark-detect-pro) beats the [Dyson][1].\n\n[1]: https://a.example/1';

  assert.equal(stripUnresolvedCitations(body, 0), body);
  assert.deepEqual(citedSourceIndexes(body), []);
});

test('the indexes a body cites are reported in ascending order, deduped', () => {
  const body = 'One.[3] Two.[1] Three.[3]';

  assert.deepEqual(citedSourceIndexes(body), [1, 3]);
});
