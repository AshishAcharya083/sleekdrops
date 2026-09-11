/**
 * The frontmatter contract, driven with what actually reaches it.
 *
 * The producer is the agent's assembler: it writes a JSON object into D1, and
 * `scripts/fetch-content.mjs` re-emits every value with `JSON.stringify` into
 * the post's YAML block. YAML 1.2 is a superset of JSON, so what this schema
 * parses at build time is exactly the object shape below — which is why the
 * fixtures here are verbatim assembler output rather than hand-tidied YAML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blogFrontmatterSchema } from './frontmatter.ts';

/** Verbatim output of `runAssembler` for a guide with picks, sources and entities. */
const assemblerOutput = {
  title: 'The best cordless stick vacuums in Australia (2026)',
  dek: 'Three worth buying, and the one to skip.',
  category: 'Home',
  postType: 'guide',
  kind: 'Buying guide',
  author: 'mira',
  tags: ['vacuums', 'home'],
  pubDate: '2026-09-10',
  readTime: 6,
  cover: 'fill-5',
  featured: false,
  draft: false,
  sources: [
    { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
    { url: 'https://www.productreview.com.au/shark', publisher: 'productreview.com.au' },
  ],
  entities: ['Dyson', 'Shark', 'HEPA filtration', 'Anti-tangle brush bar'],
  picks: [
    { name: 'Shark Detect Pro', brand: 'Shark', price: 'A$1,199', goSlug: 'shark-detect-pro' },
    { name: 'Dyson V15 Detect', brand: 'Dyson', price: '$1099.00', goSlug: 'dyson-v15-detect' },
  ],
  currency: 'AUD',
};

test("the assembler's structured-data fields survive the collection schema intact", () => {
  const parsed = blogFrontmatterSchema.parse(assemblerOutput);

  assert.deepEqual(parsed.sources, assemblerOutput.sources);
  assert.deepEqual(parsed.entities, assemblerOutput.entities);
  assert.deepEqual(parsed.picks, assemblerOutput.picks);
  assert.equal(parsed.currency, 'AUD');
  assert.equal(parsed.pubDate.toISOString(), '2026-09-10T00:00:00.000Z');
});

test('a post published before any of these fields existed still validates', () => {
  const legacy = {
    title: 'An older post',
    dek: 'Written by hand, long before the pipeline.',
    category: 'Tech',
    postType: 'article',
    author: 'mira',
    tags: [],
    pubDate: '2025-01-01',
    readTime: 3,
    cover: 'fill-1',
    featured: false,
    draft: false,
  };

  const parsed = blogFrontmatterSchema.parse(legacy);
  assert.equal(parsed.sources, undefined);
  assert.equal(parsed.entities, undefined);
  assert.equal(parsed.picks, undefined);
  // Defaulted, not required: nothing has to be backfilled for the site to build.
  assert.equal(parsed.currency, 'AUD');
});

test('a pick whose goSlug could not resolve to a /go/ route is refused', () => {
  // The slug is the affiliate route, so a malformed one would ship a dead link.
  for (const goSlug of ['Shark-Detect-Pro', 'shark_detect_pro', '/go/shark', '']) {
    const result = blogFrontmatterSchema.safeParse({
      ...assemblerOutput,
      picks: [{ name: 'Shark Detect Pro', goSlug }],
    });
    assert.equal(result.success, false, `${goSlug || '<empty>'} should be rejected`);
  }
});

test("a source's tier and part-dated publication date survive intact", () => {
  // The researcher dates a source to whatever precision it published one, and
  // files it under a tier - both ride into the visible sources block, so both
  // have to reach the collection unaltered.
  const parsed = blogFrontmatterSchema.parse({
    ...assemblerOutput,
    lastReviewed: '2026-09-11',
    sources: [
      { url: 'https://www.choice.com.au/vacuums', publisher: 'Choice', date: '2026-03-14', tier: 'expert' },
      { url: 'https://www.dyson.com.au/v15', publisher: 'Dyson', date: '2026', tier: 'primary' },
      { url: 'https://forum.example/thread', publisher: 'forum.example', tier: 'unknown' },
    ],
  });

  assert.deepEqual(
    parsed.sources?.map((source) => [source.date, source.tier]),
    [
      ['2026-03-14', 'expert'],
      ['2026', 'primary'],
      [undefined, 'unknown'],
    ],
  );
  // Distinct from pubDate and updatedDate: this is when a human last checked it.
  assert.equal(parsed.lastReviewed?.toISOString(), '2026-09-11T00:00:00.000Z');
  assert.equal(parsed.pubDate.toISOString(), '2026-09-10T00:00:00.000Z');
});

test('a tier the site cannot render, or a date it cannot read, is refused', () => {
  for (const source of [
    { url: 'https://a.example/1', tier: 'trusted' },
    { url: 'https://a.example/1', date: 'March 2026' },
    { url: 'https://a.example/1', date: '2026-3' },
  ]) {
    const result = blogFrontmatterSchema.safeParse({ ...assemblerOutput, sources: [source] });
    assert.equal(result.success, false, `${JSON.stringify(source)} should be rejected`);
  }
});

test('a source that is not an absolute URL is refused', () => {
  const result = blogFrontmatterSchema.safeParse({
    ...assemblerOutput,
    sources: [{ url: 'choice.com.au/vacuums' }],
  });
  assert.equal(result.success, false);
});

test('a review post still has to carry its product object', () => {
  const result = blogFrontmatterSchema.safeParse({ ...assemblerOutput, postType: 'review' });
  assert.equal(result.success, false);
});
