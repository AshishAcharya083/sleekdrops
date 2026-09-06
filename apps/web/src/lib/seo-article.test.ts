/**
 * The Article JSON-LD every post ships. Google's Article guidance asks for an
 * author with a `url`, a publisher whose `logo` is a logo, and dates that mean
 * something; this pins the shape so a refactor cannot quietly drop one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildArticleSchema } from './seo.ts';
import type { BlogPost } from './posts.ts';
import type { Author } from '@data/authors';

const author: Author = { id: 'theo', name: 'Theo Renn', role: 'Audio & tech', bio: 'Bio.' };

const post = {
  slug: 'harman-kardon-luna-2',
  body: '',
  data: {
    title: 'Harman Kardon Luna 2: is the $200 ambient-light speaker worth it?',
    dek: 'A balanced, good-looking portable.',
    category: 'Tech',
    postType: 'review',
    author: 'theo',
    tags: ['harman kardon', 'bluetooth speakers'],
    pubDate: new Date('2026-05-30T00:00:00Z'),
    updatedDate: new Date('2026-09-04T00:00:00Z'),
    readTime: 8,
    cover: 'fill-1',
    heroImage: 'https://images.example/hero.jpg',
    featured: false,
    draft: false,
  },
} as unknown as BlogPost;

test('the article names its author page, its language and its own URL', () => {
  const schema = buildArticleSchema(post, author) as Record<string, unknown>;
  assert.equal(schema['@type'], 'Article');
  assert.equal(schema.url, 'https://sleekdrops.com/blog/harman-kardon-luna-2');
  assert.equal(schema.inLanguage, 'en-AU');
  assert.deepEqual(schema.author, {
    '@type': 'Person',
    name: 'Theo Renn',
    url: 'https://sleekdrops.com/author/theo',
  });
  assert.deepEqual(schema.mainEntityOfPage, {
    '@type': 'WebPage',
    '@id': 'https://sleekdrops.com/blog/harman-kardon-luna-2',
  });
});

test('dateModified follows updatedDate, and falls back to the publish date', () => {
  const updated = buildArticleSchema(post, author) as Record<string, unknown>;
  assert.equal(updated.datePublished, '2026-05-30T00:00:00.000Z');
  assert.equal(updated.dateModified, '2026-09-04T00:00:00.000Z');

  const fresh = { ...post, data: { ...post.data, updatedDate: undefined } } as unknown as BlogPost;
  const first = buildArticleSchema(fresh, author) as Record<string, unknown>;
  assert.equal(first.dateModified, first.datePublished);
});

test('the publisher logo is the square mark as an ImageObject, not the social card', () => {
  const schema = buildArticleSchema(post, author) as { publisher: Record<string, unknown> };
  assert.equal(schema.publisher['@type'], 'Organization');
  assert.deepEqual(schema.publisher.logo, {
    '@type': 'ImageObject',
    url: 'https://sleekdrops.com/mark.svg',
  });
  // The hero, when there is one, is the article image; the card is only the fallback.
  assert.deepEqual((schema as Record<string, unknown>).image, ['https://images.example/hero.jpg']);
});
