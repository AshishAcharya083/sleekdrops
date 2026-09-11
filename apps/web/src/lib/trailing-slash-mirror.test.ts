/**
 * The mirror plan is what stops ERR_TOO_MANY_REDIRECTS coming back: every page
 * has to answer 200 at both forms of its URL, because a browser holding a
 * cached 308 from the old URL shape can only be let out by a 200 at the form
 * that redirect points to. These cases are the build's real output shapes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planTrailingSlashMirrors } from './trailing-slash-mirror.mjs';

const mirrorsOf = (paths: string[]) =>
  planTrailingSlashMirrors(paths).map(({ mirror }) => mirror);

test('every page gains the trailing-slash form the old build served', () => {
  assert.deepEqual(
    mirrorsOf(['about.html', 'blog/xiaomi-17-ultra.html', 'category/tech.html']),
    ['about/index.html', 'blog/xiaomi-17-ultra/index.html', 'category/tech/index.html'],
  );
});

test('a listing that shares a name with a directory is mirrored into it', () => {
  // blog.html and blog/<slug>.html both exist; /blog/ has to stop 308ing too.
  assert.deepEqual(mirrorsOf(['blog.html', 'blog/xiaomi-17-ultra.html']), [
    'blog/index.html',
    'blog/xiaomi-17-ultra/index.html',
  ]);
});

test('index.html is already the trailing-slash form and is left alone', () => {
  assert.deepEqual(mirrorsOf(['index.html', 'blog/index.html']), []);
});

test('404.html is Pages’ miss handler, not a page with a cached redirect', () => {
  assert.deepEqual(mirrorsOf(['404.html']), []);
});

test('a directory form the build already wrote is never overwritten', () => {
  assert.deepEqual(mirrorsOf(['about.html', 'about/index.html']), []);
});

test('non-HTML build output is not mirrored', () => {
  assert.deepEqual(mirrorsOf(['rss.xml', 'robots.txt', '_astro/hoisted.js']), []);
});

test('the plan names the file each copy is made from', () => {
  assert.deepEqual(planTrailingSlashMirrors(['blog/xiaomi-17-ultra.html']), [
    { source: 'blog/xiaomi-17-ultra.html', mirror: 'blog/xiaomi-17-ultra/index.html' },
  ]);
});
