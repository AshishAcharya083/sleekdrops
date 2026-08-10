import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findBrokenAnchors } from './anchor-integrity.ts';

test('an anchor whose target renders is not reported', () => {
  const html = '<a href="#today">See today\'s drop</a><aside id="today"></aside>';
  assert.deepEqual(findBrokenAnchors(html), []);
});

test('the shipped defect is reported: #today with no drop panel', () => {
  const html = '<a class="btn" href="#today" data-track="Hero CTA Clicked">See today\'s drop</a>';
  assert.deepEqual(findBrokenAnchors(html), [{ href: '#today', id: 'today' }]);
});

test('each broken href is reported once however many links share it', () => {
  const html = '<a href="#gone">a</a><a href="#gone">b</a>';
  assert.equal(findBrokenAnchors(html).length, 1);
});

test('bare "#" and "#top" need no element', () => {
  assert.deepEqual(findBrokenAnchors('<a href="#">x</a><a href="#top">y</a>'), []);
});

test('a legacy <a name> target counts as a target', () => {
  assert.deepEqual(findBrokenAnchors('<a href="#old">x</a><a name="old"></a>'), []);
});

test('percent-encoded and entity-escaped fragments match their id', () => {
  assert.deepEqual(findBrokenAnchors('<a href="#caf%C3%A9">x</a><h2 id="café"></h2>'), []);
  assert.deepEqual(findBrokenAnchors('<a href="#a&amp;b">x</a><h2 id="a&b"></h2>'), []);
});

test('an href on another attribute-bearing element is still matched', () => {
  // Astro emits scoped-style attributes between the tag name and href, so the
  // pattern must not assume href comes first.
  const html = '<a data-astro-cid-x class="btn" href="#missing" data-track="x">y</a>';
  assert.deepEqual(findBrokenAnchors(html), [{ href: '#missing', id: 'missing' }]);
});

test('single-quoted attributes are read, not silently skipped', () => {
  // Astro double-quotes everything, but public/ ships hand-written HTML as-is.
  assert.deepEqual(findBrokenAnchors("<a href='#ok'>x</a><h2 id='ok'></h2>"), []);
  assert.deepEqual(findBrokenAnchors("<a href='#gone'>x</a>"), [{ href: '#gone', id: 'gone' }]);
});

test('an SVG sprite reference to a missing symbol is reported too', () => {
  assert.deepEqual(findBrokenAnchors('<svg><use href="#icon-a"/></svg><symbol id="icon-a"></symbol>'), []);
  assert.deepEqual(findBrokenAnchors('<svg><use href="#icon-b"/></svg>'), [
    { href: '#icon-b', id: 'icon-b' },
  ]);
});

test('cross-page hrefs carrying a fragment are not treated as in-page links', () => {
  assert.deepEqual(findBrokenAnchors('<a href="/deals#today">x</a>'), []);
});

test('an article TOC linking to its own headings passes', () => {
  const html = `
    <nav data-toc><a href="#intro">Intro</a><a href="#verdict">Verdict</a></nav>
    <h2 id="intro"></h2><h2 id="verdict"></h2>`;
  assert.deepEqual(findBrokenAnchors(html), []);
});
