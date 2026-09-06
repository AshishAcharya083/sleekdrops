// Editing the hero image of a post that is already live means rewriting the
// frontmatter the website builds from. Everything else in that JSON — title,
// dek, tags, pubDate — exists nowhere else, so these are the tests that keep a
// photo swap from taking a published page down with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchHeroFrontmatter } from './d1.js';

const post = {
  title: 'The best cordless stick vacuums',
  dek: 'Six tested.',
  tags: ['vacuums'],
  pubDate: '2026-07-01',
  cover: 'fill-2',
};

test('sets the hero and leaves every other key alone', () => {
  const out = patchHeroFrontmatter(JSON.stringify(post), {
    heroImage: 'https://storage.googleapis.com/sleekdrops-images/heroes/uploads/post-x-ab12cd34.jpg',
    heroAlt: 'A stick vacuum on floorboards',
  });

  assert.equal(out.heroImage, 'https://storage.googleapis.com/sleekdrops-images/heroes/uploads/post-x-ab12cd34.jpg');
  assert.equal(out.heroAlt, 'A stick vacuum on floorboards');
  assert.equal(out.title, post.title);
  assert.deepEqual(out.tags, post.tags);
  assert.equal(out.pubDate, '2026-07-01');
});

test('replaces the hero an older post already had', () => {
  const out = patchHeroFrontmatter(
    JSON.stringify({ ...post, heroImage: 'https://images.sleekdrops.com/old.jpg', heroAlt: 'Old' }),
    { heroImage: 'https://storage.googleapis.com/bucket/new.jpg', heroAlt: 'New' },
  );

  assert.equal(out.heroImage, 'https://storage.googleapis.com/bucket/new.jpg');
  assert.equal(out.heroAlt, 'New');
});

test('an image with no alt text drops the stale alt rather than nulling it', () => {
  // A JSON null fails the site's frontmatter schema, where heroAlt is an
  // optional string — the build would break on the next content fetch.
  const out = patchHeroFrontmatter(
    JSON.stringify({ ...post, heroImage: 'https://images.sleekdrops.com/old.jpg', heroAlt: 'Old' }),
    { heroImage: 'https://storage.googleapis.com/bucket/new.jpg', heroAlt: null },
  );

  assert.equal('heroAlt' in out, false);
  assert.equal(out.heroImage, 'https://storage.googleapis.com/bucket/new.jpg');
});

test('clearing the hero removes both keys, not the rest of the post', () => {
  const out = patchHeroFrontmatter(
    JSON.stringify({ ...post, heroImage: 'https://images.sleekdrops.com/old.jpg', heroAlt: 'Old' }),
    { heroImage: null, heroAlt: null },
  );

  assert.equal('heroImage' in out, false);
  assert.equal('heroAlt' in out, false);
  assert.equal(out.title, post.title);
});

test('malformed frontmatter throws instead of being overwritten', () => {
  // The alternative is writing back { heroImage } alone and losing the only
  // copy of the post's title, dek and tags.
  assert.throws(() => patchHeroFrontmatter('{not json', { heroImage: 'https://x/y.jpg', heroAlt: null }), /not valid JSON/);
  assert.throws(() => patchHeroFrontmatter('[1,2]', { heroImage: 'https://x/y.jpg', heroAlt: null }), /not an object/);
  assert.throws(() => patchHeroFrontmatter('null', { heroImage: 'https://x/y.jpg', heroAlt: null }), /not an object/);
});
