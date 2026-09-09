/**
 * Body affiliate links are markdown `[text](/go/<slug>)`, rendered by Astro's
 * markdown pipeline rather than by a component - so the one place their `rel`
 * can be set is a rehype plugin, and this is the test that it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import rehypeAffiliateLinks, {
  isAffiliateAnchor,
  markAffiliateAnchor,
  type HastNode,
} from './rehype-affiliate-links.mjs';

const anchor = (href: string, rel?: unknown): HastNode => ({
  type: 'element',
  tagName: 'a',
  properties: { href, ...(rel === undefined ? {} : { rel }) },
  children: [{ type: 'text', value: 'See it on Amazon' }],
});

const run = (tree: HastNode): HastNode => {
  rehypeAffiliateLinks()(tree);
  return tree;
};

test('a /go/ link gets rel="sponsored noopener"', () => {
  const tree: HastNode = { type: 'root', children: [anchor('/go/sony-wh-1000xm6')] };
  run(tree);
  assert.deepEqual(tree.children?.[0]?.properties?.rel, ['sponsored', 'noopener']);
});

test('links deep in the tree are found - a table cell, a list item, a paragraph', () => {
  const tree: HastNode = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'table',
        children: [
          {
            type: 'element',
            tagName: 'tr',
            children: [{ type: 'element', tagName: 'td', children: [anchor('/go/jbl-flip-7')] }],
          },
        ],
      },
      { type: 'element', tagName: 'p', children: [anchor('/go/jbl-go-4?placement=cta')] },
    ],
  };
  run(tree);
  const cell = tree.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0];
  const para = tree.children?.[1]?.children?.[0];
  assert.deepEqual(cell?.properties?.rel, ['sponsored', 'noopener']);
  assert.deepEqual(para?.properties?.rel, ['sponsored', 'noopener']);
});

test('an existing rel is kept and extended, not replaced, and never duplicated', () => {
  const asString = anchor('/go/x', 'nofollow');
  markAffiliateAnchor(asString.properties!);
  assert.deepEqual(asString.properties?.rel, ['nofollow', 'sponsored', 'noopener']);

  const asList = anchor('/go/x', ['sponsored', 'noopener']);
  markAffiliateAnchor(asList.properties!);
  assert.deepEqual(asList.properties?.rel, ['sponsored', 'noopener']);
});

test('only /go/ anchors are touched', () => {
  const tree: HastNode = {
    type: 'root',
    children: [
      anchor('/blog/best-budget-mattress-australia'),
      anchor('https://www.rode.com/'),
      anchor('/goods/not-a-redirect'),
      anchor('/go/'),
      { type: 'element', tagName: 'img', properties: { src: '/go/nope.png' } },
    ],
  };
  run(tree);
  for (const node of tree.children ?? []) {
    assert.equal(node.properties?.rel, undefined, `${String(node.properties?.href)} must be left alone`);
  }
  assert.equal(isAffiliateAnchor({ type: 'text', value: '/go/x' }), false);
  assert.equal(isAffiliateAnchor(anchor('/go/x')), true);
});
