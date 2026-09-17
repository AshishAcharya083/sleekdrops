/**
 * Citation markers in a body, turned into links into the sources block.
 *
 * The rule that matters most here is the negative one: a marker is only ever
 * linked when the post carries that source. An anchor to a row the page does
 * not render is a dead in-page link, which `scripts/check-anchors.mjs` fails
 * the build over - rightly, because it is a citation that cites nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import rehypeCitations, { linkCitations, sourceAnchorId, splitCitations } from './rehype-citations.mjs';
import type { HastNode } from './rehype-citations.mjs';

const text = (value: string): HastNode => ({ type: 'text', value });

const paragraph = (...children: HastNode[]): HastNode => ({
  type: 'element',
  tagName: 'p',
  properties: {},
  children,
});

const tree = (...children: HastNode[]): HastNode => ({ type: 'root', children });

/** The file object Astro hands a rehype plugin for a content-collection entry. */
const file = (sources: unknown) => ({ data: { astro: { frontmatter: { sources } } } });

test('a marker becomes a superscript link to its row in the sources block', () => {
  const root = tree(paragraph(text('Choice measured 210AW in 2026.[1]')));

  rehypeCitations()(root, file([{ url: 'https://www.choice.com.au/vacuums' }]));

  const [sentence, marker] = root.children![0].children as HastNode[];
  assert.equal(sentence.value, 'Choice measured 210AW in 2026.');
  assert.equal(marker.tagName, 'sup');
  assert.deepEqual(marker.properties, { className: ['citation'] });
  const link = marker.children![0];
  assert.equal(link.properties?.href, `#${sourceAnchorId(1)}`);
  assert.equal(link.properties?.['aria-label'], 'Source 1');
  assert.equal(link.children![0].value, '[1]');
});

test('a marker past the end of the list is left as text, never linked', () => {
  const root = tree(paragraph(text('Owners disagree.[4]')));

  rehypeCitations()(root, file([{ url: 'https://a.example/1' }]));

  assert.deepEqual(root.children![0].children, [text('Owners disagree.[4]')]);
});

test('a post with no sources is left exactly as written', () => {
  const root = tree(paragraph(text('A bracketed aside [1] nobody cited.')));

  rehypeCitations()(root, file(undefined));

  assert.deepEqual(root.children![0].children, [text('A bracketed aside [1] nobody cited.')]);
});

test('code samples and existing links are left alone', () => {
  const code: HastNode = {
    type: 'element',
    tagName: 'code',
    properties: {},
    children: [text('items[1]')],
  };
  const anchor: HastNode = {
    type: 'element',
    tagName: 'a',
    properties: { href: '/go/shark-detect-pro' },
    children: [text('Shark Detect Pro [1]')],
  };
  const root = tree(paragraph(code, anchor));

  linkCitations(root, 3);

  assert.deepEqual(code.children, [text('items[1]')]);
  assert.deepEqual(anchor.children, [text('Shark Detect Pro [1]')]);
});

test('several markers in one sentence each keep their own number', () => {
  const split = splitCitations('Both agree.[1] And the third.[3] End.', 3);

  assert.equal(split?.length, 5);
  assert.deepEqual(
    split?.filter((node) => node.tagName === 'sup').map((node) => node.children![0].properties?.href),
    ['#source-1', '#source-3'],
  );
  assert.equal(split?.at(-1)?.value, ' End.');
});

test('text with nothing to link is returned untouched, not rebuilt', () => {
  assert.equal(splitCitations('No markers here at all.', 4), null);
});
