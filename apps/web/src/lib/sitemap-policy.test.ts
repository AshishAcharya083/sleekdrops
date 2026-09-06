/**
 * The sitemap policy decides two things a crawler acts on: which URLs are worth
 * listing, and when each last changed. Both are derived from the generated post
 * frontmatter, so the parser is tested against the exact shape
 * scripts/fetch-content.mjs writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify as siteSlugify } from './format.ts';
import {
  MIN_TAG_POSTS,
  createSitemapPolicy,
  isIndexableTag,
  latestChange,
  parseFrontmatter,
  slugify,
  toPostRecord,
} from './sitemap-policy.mjs';

const NOW = new Date('2026-09-06T12:00:00Z');

/** A post as fetch-content.mjs writes it: `key: <JSON>` per line. */
const generated = `---
title: "Best cordless stick vacuums in Australia (2026)"
dek: "Six vacuums compared."
category: "Home"
postType: "roundup"
author: "mira"
tags: ["Cordless Vacuums","Australia","Dyson alternatives"]
pubDate: "2026-08-30"
updatedDate: "2026-09-04"
readTime: 9
cover: "fill-2"
featured: false
draft: false
---

Body starts here.
`;

const post = (slug: string, data: Record<string, unknown>) =>
  toPostRecord(slug, { category: 'Tech', author: 'theo', postType: 'article', tags: [], ...data }, NOW);

test('parseFrontmatter reads the generated key: JSON format, including arrays', () => {
  const data = parseFrontmatter(generated);
  assert.ok(data);
  assert.equal(data.title, 'Best cordless stick vacuums in Australia (2026)');
  assert.deepEqual(data.tags, ['Cordless Vacuums', 'Australia', 'Dyson alternatives']);
  assert.equal(data.readTime, 9);
  assert.equal(data.draft, false);
  assert.equal(parseFrontmatter('no fence here'), null);
});

test('toPostRecord mirrors isLivePost: drafts and future posts are not live', () => {
  const record = toPostRecord('vacuums', parseFrontmatter(generated)!, NOW);
  assert.equal(record.live, true);
  assert.equal(record.updatedDate?.toISOString().slice(0, 10), '2026-09-04');
  assert.equal(post('draft', { pubDate: '2026-09-01', draft: true }).live, false);
  assert.equal(post('scheduled', { pubDate: '2026-09-07' }).live, false);
  assert.equal(post('undated', {}).live, false);
});

test('slugify agrees with the site helper, so tag URLs match the pages Astro emits', () => {
  for (const tag of ['Dyson alternatives', 'Samsung Galaxy S26 Ultra', '  Bed-in-a-box ', 'RØDE mics']) {
    assert.equal(slugify(tag), siteSlugify(tag));
  }
});

test('latestChange prefers updatedDate over pubDate and returns a W3C day', () => {
  const posts = [
    post('a', { pubDate: '2026-05-30' }),
    post('b', { pubDate: '2026-06-21', updatedDate: '2026-09-01' }),
    post('c', { pubDate: '2026-08-15' }),
  ];
  assert.equal(latestChange(posts), '2026-09-01');
  assert.equal(latestChange([]), undefined);
});

test('a tag page below the threshold is dropped from the sitemap; one at it stays', () => {
  const posts = [
    post('a', { pubDate: '2026-08-01', tags: ['Australia', 'Budget vacuum'] }),
    post('b', { pubDate: '2026-08-02', tags: ['Australia'] }),
    post('c', { pubDate: '2026-08-03', tags: ['Australia'] }),
  ];
  const policy = createSitemapPolicy(posts);
  assert.equal(MIN_TAG_POSTS, 3);
  assert.equal(isIndexableTag(1), false);
  assert.equal(isIndexableTag(3), true);
  assert.equal(policy.filter('https://sleekdrops.com/tag/australia'), true);
  assert.equal(policy.filter('https://sleekdrops.com/tag/australia/2'), true);
  assert.equal(policy.filter('https://sleekdrops.com/tag/budget-vacuum'), false);
  assert.equal(policy.filter('https://sleekdrops.com/tag/never-used'), false);
});

test('the reviews hub is listed only once there is a review to list', () => {
  const none = createSitemapPolicy([post('a', { pubDate: '2026-08-01', postType: 'roundup' })]);
  assert.equal(none.filter('https://sleekdrops.com/reviews'), false);
  assert.equal(none.filter('https://sleekdrops.com/reviews/2'), false);
  const some = createSitemapPolicy([post('a', { pubDate: '2026-08-01', postType: 'review' })]);
  assert.equal(some.filter('https://sleekdrops.com/reviews'), true);
  assert.equal(some.filter('https://sleekdrops.com/about'), true, 'everything else is untouched');
});

test('lastmod follows the content each route lists', () => {
  const posts = [
    post('luna-2', { pubDate: '2026-05-30', category: 'Tech', author: 'theo', tags: ['Bluetooth speakers'] }),
    post('mattress', { pubDate: '2026-07-10', updatedDate: '2026-08-20', category: 'Home', author: 'mira', postType: 'guide', tags: ['Australia'] }),
    post('mics', { pubDate: '2026-09-04', category: 'Tech', author: 'theo', postType: 'roundup', tags: ['Australia'] }),
  ];
  const policy = createSitemapPolicy(posts);
  const lastmod = (path: string) => policy.lastmodFor(path);

  assert.equal(lastmod('/blog/luna-2'), '2026-05-30');
  assert.equal(lastmod('/blog/mattress'), '2026-08-20', 'a re-published post carries its update date');
  assert.equal(lastmod('/'), '2026-09-04');
  assert.equal(lastmod('/blog'), '2026-09-04');
  assert.equal(lastmod('/blog/2'), '2026-09-04', 'pagination is the listing, not a post');
  assert.equal(lastmod('/category/tech'), '2026-09-04');
  assert.equal(lastmod('/category/home'), '2026-08-20');
  assert.equal(lastmod('/tag/australia'), '2026-09-04');
  assert.equal(lastmod('/tag/bluetooth-speakers'), '2026-05-30');
  assert.equal(lastmod('/author/mira'), '2026-08-20');
  assert.equal(lastmod('/guides'), '2026-08-20');
  assert.equal(lastmod('/reviews'), undefined, 'nothing listed, nothing changed');
  assert.equal(lastmod('/about'), undefined, 'static pages carry no date we can vouch for');
  assert.equal(lastmod('/blog/not-a-post'), undefined);
});

test('serialize adds lastmod only when one is known, and keeps the entry otherwise', () => {
  const policy = createSitemapPolicy([post('luna-2', { pubDate: '2026-05-30' })]);
  assert.deepEqual(policy.serialize({ url: 'https://sleekdrops.com/blog/luna-2' }), {
    url: 'https://sleekdrops.com/blog/luna-2',
    lastmod: '2026-05-30',
  });
  assert.deepEqual(policy.serialize({ url: 'https://sleekdrops.com/contact' }), {
    url: 'https://sleekdrops.com/contact',
  });
  // A trailing slash on the way in must not defeat the match: the site's canonical
  // form has none, but the hook is fed whatever the integration produces.
  assert.equal(policy.serialize({ url: 'https://sleekdrops.com/blog/luna-2/' }).lastmod, '2026-05-30');
});
