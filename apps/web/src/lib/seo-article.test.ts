/**
 * The Article graph every post ships. Google's Article guidance asks for an
 * author with a `url`, a publisher whose `logo` is a logo, and dates that mean
 * something; this pins the shape so a refactor cannot quietly drop one. The
 * graph wiring itself (entities, citations, picks) is in seo-graph.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildArticleSchema } from './seo.ts';
import type { BlogPost } from './posts.ts';
import type { Author } from '@data/authors';

const author: Author = {
  id: 'desk',
  name: 'SleekDrops Editorial Desk',
  role: 'Editorial team',
  bio: 'Research-led coverage.',
};

const post = {
  slug: 'harman-kardon-luna-2',
  body: '',
  data: {
    title: 'Harman Kardon Luna 2: is the $200 ambient-light speaker worth it?',
    dek: 'A balanced, good-looking portable.',
    category: 'Tech',
    postType: 'review',
    author: 'desk',
    tags: ['harman kardon', 'bluetooth speakers'],
    pubDate: new Date('2026-05-30T00:00:00Z'),
    updatedDate: new Date('2026-09-04T00:00:00Z'),
    readTime: 8,
    cover: 'fill-1',
    heroImage: 'https://images.example/hero.jpg',
    currency: 'AUD',
    featured: false,
    draft: false,
  },
} as unknown as BlogPost;

type Node = Record<string, unknown>;

/** The graph's node of a given @type — every builder here returns one @graph. */
function node(schema: unknown, type: string): Node {
  const nodes = (schema as { '@graph': Node[] })['@graph'];
  const found = nodes.find((entry) => entry['@type'] === type);
  assert.ok(found, `no ${type} node in the graph`);
  return found;
}

/** By `@id`, for the two Organization nodes: the publisher and the byline. */
function nodeById(schema: unknown, id: string): Node {
  const nodes = (schema as { '@graph': Node[] })['@graph'];
  const found = nodes.find((entry) => entry['@id'] === id);
  assert.ok(found, `no node with @id ${id} in the graph`);
  return found;
}

test('the article names its byline node, its language and its own URL', () => {
  const schema = buildArticleSchema(post, author);
  assert.equal((schema as Node)['@context'], 'https://schema.org');

  const article = node(schema, 'Article');
  assert.equal(article.url, 'https://sleekdrops.com/blog/harman-kardon-luna-2');
  assert.equal(article['@id'], 'https://sleekdrops.com/blog/harman-kardon-luna-2#article');
  assert.equal(article.inLanguage, 'en-AU');
  assert.deepEqual(article.author, { '@id': 'https://sleekdrops.com/author/desk#byline' });

  const byline = nodeById(schema, 'https://sleekdrops.com/author/desk#byline');
  // The site publishes under one labelled editorial desk, so the byline is an
  // Organization; a Person node would claim a human reviewer nobody is shown.
  assert.equal(byline['@type'], 'Organization');
  assert.equal(byline.url, 'https://sleekdrops.com/author/desk');
  assert.equal(byline.name, 'SleekDrops Editorial Desk');
  assert.deepEqual(byline.parentOrganization, { '@id': 'https://sleekdrops.com/#organization' });
  assert.deepEqual(byline.knowsAbout, ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel']);
});

test('the article is part of a WebPage node, which is part of the site', () => {
  const schema = buildArticleSchema(post, author);
  const pageId = 'https://sleekdrops.com/blog/harman-kardon-luna-2#webpage';

  const article = node(schema, 'Article');
  assert.deepEqual(article.isPartOf, { '@id': pageId });
  assert.deepEqual(article.mainEntityOfPage, { '@id': pageId });

  const webPage = node(schema, 'WebPage');
  assert.equal(webPage['@id'], pageId);
  assert.equal(webPage.url, 'https://sleekdrops.com/blog/harman-kardon-luna-2');
  assert.deepEqual(webPage.isPartOf, { '@id': 'https://sleekdrops.com/#website' });
});

test('dateModified follows updatedDate, and falls back to the publish date', () => {
  const updated = node(buildArticleSchema(post, author), 'Article');
  assert.equal(updated.datePublished, '2026-05-30T00:00:00.000Z');
  assert.equal(updated.dateModified, '2026-09-04T00:00:00.000Z');
  assert.notEqual(updated.dateModified, updated.datePublished);

  const fresh = { ...post, data: { ...post.data, updatedDate: undefined } } as unknown as BlogPost;
  const first = node(buildArticleSchema(fresh, author), 'Article');
  assert.equal(first.dateModified, first.datePublished);
});

test('the publisher logo is the square mark as an ImageObject, not the social card', () => {
  const schema = buildArticleSchema(post, author);
  const publisher = node(schema, 'Organization');
  assert.equal(publisher['@id'], 'https://sleekdrops.com/#organization');
  assert.deepEqual(publisher.logo, {
    '@type': 'ImageObject',
    url: 'https://sleekdrops.com/mark.svg',
  });
  assert.deepEqual(node(schema, 'Article').publisher, {
    '@id': 'https://sleekdrops.com/#organization',
  });
  // The hero, when there is one, is the article image; the card is only the fallback.
  assert.deepEqual(node(schema, 'Article').image, ['https://images.example/hero.jpg']);
});
