import { test } from 'node:test';
import assert from 'node:assert/strict';

import { queryTerms, searchPosts, type SearchDoc } from './search.ts';

const docs: SearchDoc[] = [
  {
    title: 'The best noise-cancelling headphones',
    dek: 'We tested a dozen pairs for the commute.',
    category: 'Tech',
    tags: ['audio', 'headphones'],
    author: 'Theo Renn',
    url: '/blog/best-headphones',
  },
  {
    title: 'A quiet electric kettle worth the counter space',
    dek: 'Fast, near-silent, and it looks the part.',
    category: 'Home',
    tags: ['kitchen', 'appliances'],
    author: 'Mira Kapoor',
    url: '/blog/quiet-kettle',
  },
  {
    title: 'Sleep trackers that actually help',
    dek: 'Honest headphones-free advice on wearables.',
    category: 'Health',
    tags: ['wearables', 'sleep'],
    author: 'Aiko Tanaka',
    url: '/blog/sleep-trackers',
  },
];

test('queryTerms lowercases, splits on whitespace, and dedupes', () => {
  assert.deepEqual(queryTerms('  Quiet   QUIET kettle '), ['quiet', 'kettle']);
});

test('an empty or whitespace-only query returns no results', () => {
  assert.deepEqual(searchPosts(docs, ''), []);
  assert.deepEqual(searchPosts(docs, '   '), []);
});

test('matches a single term across title, tags, and dek', () => {
  const matches = searchPosts(docs, 'headphones').map((d) => d.url);
  assert.deepEqual(matches, ['/blog/best-headphones', '/blog/sleep-trackers']);
});

test('a title hit ranks above a dek-only hit for the same term', () => {
  // "best-headphones" hits title + tags; "sleep-trackers" only hits the dek.
  const ranked = searchPosts(docs, 'headphones');
  assert.equal(ranked[0].url, '/blog/best-headphones');
});

test('all terms must match somewhere (AND semantics)', () => {
  assert.deepEqual(
    searchPosts(docs, 'quiet kettle').map((d) => d.url),
    ['/blog/quiet-kettle'],
  );
  // "kettle" matches one doc, "headphones" another — no doc has both.
  assert.deepEqual(searchPosts(docs, 'kettle headphones'), []);
});

test('search matches category and author names', () => {
  assert.deepEqual(
    searchPosts(docs, 'health').map((d) => d.url),
    ['/blog/sleep-trackers'],
  );
  assert.deepEqual(
    searchPosts(docs, 'mira').map((d) => d.url),
    ['/blog/quiet-kettle'],
  );
});

test('search is case-insensitive', () => {
  assert.deepEqual(
    searchPosts(docs, 'HEADPHONES').map((d) => d.url),
    searchPosts(docs, 'headphones').map((d) => d.url),
  );
});

test('a non-matching query returns an empty list rather than throwing', () => {
  assert.deepEqual(searchPosts(docs, 'zzzznope'), []);
});
