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

// ── Measurements, carried through rather than rebuilt ────────────────────────
// A protocol is what makes a figure checkable, so it travels with the figure.
// The tier, the publisher and the date already rode through; what was being
// thrown away was what the source actually measured.

const measuredClaim = {
  metric: 'Peak brightness',
  measuredValue: '1,684 nits',
  measuredBy: 'Notebookcheck',
  conditions: 'spectrophotometer, 10% APL',
  measuredOn: '2026-09-16',
  measuredSourceUrl: 'https://www.notebookcheck.net/iphone-18-pro',
  withdrawnValue: '2,140 nits',
};

test('a measurement lands on the source row the fact already carried', () => {
  const [source] = articleSources(
    [
      {
        fact: 'Measured 1,684 nits.',
        sourceUrl: 'https://www.notebookcheck.net/iphone-18-pro',
        tier: 'expert',
        date: '2026-09-16',
        publisher: 'Notebookcheck',
      },
    ],
    [measuredClaim],
  );
  assert.equal(source.metric, 'Peak brightness');
  assert.equal(source.measured, '1,684 nits');
  assert.equal(source.conditions, 'spectrophotometer, 10% APL');
  assert.equal(source.withdrawn, '2,140 nits', 'a withdrawn figure stays visible beside the corrected one');
});

test('a tester the facts never quoted is appended, never inserted', () => {
  // The body's citation markers are numbered against the fact rows, so a new
  // row among them would renumber every marker after it.
  const sources = articleSources(
    [
      { fact: 'Apple states 3,000 nits.', sourceUrl: 'https://www.apple.com/au/iphone', tier: 'primary',
        date: '2026-09-09', publisher: 'Apple' },
    ],
    [measuredClaim],
  );
  assert.deepEqual(sources.map((s) => s.publisher), ['Apple', 'Notebookcheck']);
  assert.equal(sources[1].tier, 'expert', 'somebody who published a protocol is the expert stratum');
  assert.equal(sources[1].date, '2026-09-16');
});

test('a claim nobody measured adds no source row', () => {
  const sources = articleSources([], [{ ...measuredClaim, measuredValue: null, measuredSourceUrl: null }]);
  assert.deepEqual(sources, []);
});

test('a post with no claims produces exactly the list it always did', () => {
  const facts = [
    { fact: 'a', sourceUrl: 'https://a.test/1', tier: 'primary' as const, date: '2026-01', publisher: 'A' },
  ];
  assert.deepEqual(articleSources(facts), articleSources(facts, []));
});

// ── Cohort raters, which are never a tested claim ────────────────────────────
// A Canstar Blue star rating is a brand satisfaction panel and a CHOICE score
// covers the cohort CHOICE tested. Either one filed as the expert stratum
// would be shown to a reader under "Independent testing", beside a measured
// figure, as evidence about a model neither of them measured.

const canstarClaim = {
  metric: 'Owner satisfaction',
  measuredValue: '4 out of 5 stars',
  measuredBy: 'Canstar Blue',
  conditions: null,
  measuredOn: '2026-06',
  measuredSourceUrl: 'https://www.canstarblue.com.au/phones/mobile-phones',
  withdrawnValue: null,
};

test('a cohort rater cited only in the claims is an aggregator row, carrying no measurement', () => {
  const [source] = articleSources([], [canstarClaim]);

  assert.equal(source.publisher, 'Canstar Blue');
  assert.equal(source.tier, 'aggregator', 'a brand survey is never the expert stratum');
  assert.equal(source.measured, undefined, 'a rating is not a measurement of the model on the page');
  assert.equal(source.metric, undefined);
});

test('a cohort rater the facts already cite keeps its row and gains no measured figure', () => {
  const [source] = articleSources(
    [
      {
        fact: 'Rated 4 out of 5 for satisfaction.',
        sourceUrl: 'https://www.canstarblue.com.au/phones/mobile-phones',
        tier: 'aggregator' as const,
        date: '2026-06',
        publisher: 'Canstar Blue',
      },
    ],
    [canstarClaim],
  );

  assert.equal(source.tier, 'aggregator');
  assert.equal(source.measured, undefined);
});

test('a CHOICE lab result on this model is an expert row carrying its figure', () => {
  // The other side of the same rule: the claim is labelled "independently
  // measured" when CHOICE's own coverage names the model it bench-tested, so
  // the source row has to say the same thing the label does.
  const [source] = articleSources(
    [],
    [
      {
        ...canstarClaim,
        subject: 'iPhone 18 Pro',
        metric: 'Lab score',
        measuredBy: 'CHOICE',
        measuredSourceUrl: 'https://www.choice.com.au/phones/best-phones',
        measuredValue: '78/100',
        covers: 'the 14 handsets CHOICE lab-tested in August 2026, including the iPhone 18 Pro',
      },
    ],
  );

  assert.equal(source.tier, 'expert');
  assert.equal(source.measured, '78/100');
  assert.equal(source.metric, 'Lab score');
});

test('a CHOICE cohort score is an aggregator row, the same thing the claim is labelled', () => {
  const [source] = articleSources(
    [],
    [
      {
        ...canstarClaim,
        measuredBy: 'CHOICE',
        measuredSourceUrl: 'https://www.choice.com.au/phones/best-phones',
        measuredValue: '78/100',
      },
    ],
  );

  assert.equal(source.tier, 'aggregator');
  assert.equal(source.measured, undefined);
});

test('a cohort rater with no figure extracted is still an aggregator row', () => {
  // The claim tier answers "manufacturer" for any row without a measured
  // value, before it ever looks at who published it - so a tier test alone
  // filed this as the expert stratum, and the panel printed a canstarblue.com.au
  // page under "Independent testing / published a protocol beside the number".
  const [source] = articleSources([], [{ ...canstarClaim, measuredValue: null }]);

  assert.equal(source.publisher, 'Canstar Blue');
  assert.equal(source.tier, 'aggregator', 'a brand survey is never the expert stratum');
  assert.equal(source.measured, undefined);
});

test('a cited page with no measurement behind it is placed as unknown, never promoted', () => {
  const [source] = articleSources(
    [],
    [
      {
        ...canstarClaim,
        measuredBy: 'Notebookcheck',
        measuredSourceUrl: 'https://www.notebookcheck.net/iphone-18-pro',
        measuredValue: null,
      },
    ],
  );

  assert.equal(source.tier, 'unknown', 'being cited is not the same as having published a figure');
  assert.equal(source.measured, undefined);
});
