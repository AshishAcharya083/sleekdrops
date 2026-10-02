// The SleekDrops profile is the text its prompts were built from, moved
// verbatim. Until every prompt reads it from the registry, the constants it was
// copied from still exist - and the two must not drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EDITORIAL_RULES, siteContext } from '../../agents/context.js';
import { SCOUT_QUERIES } from '../../agents/topicScout.js';
import { CATEGORIES, HOME_CURRENCY, POST_TYPES } from '../../content/contract.js';
import { ARTICLE_SHAPES } from '../../pipeline/types.js';
import { SLEEKDROPS_AU_EDITION_ID, SLEEKDROPS_PROFILE } from './index.js';

test('brand text and audience are the site context, verbatim and in order', () => {
  const { brandText, audience } = SLEEKDROPS_PROFILE;
  assert.ok(siteContext().startsWith(`${brandText} ${audience}\n`));
});

test('categories, post types, shapes, rules and scout queries are the current ones', () => {
  assert.deepEqual(SLEEKDROPS_PROFILE.categories, [...CATEGORIES]);
  assert.deepEqual(SLEEKDROPS_PROFILE.postTypes, [...POST_TYPES]);
  assert.deepEqual(SLEEKDROPS_PROFILE.articleShapes, Object.keys(ARTICLE_SHAPES));
  assert.equal(SLEEKDROPS_PROFILE.editorialRules, EDITORIAL_RULES);
  const [edition] = SLEEKDROPS_PROFILE.editions;
  assert.deepEqual([...SLEEKDROPS_PROFILE.scoutQueries, ...edition.scoutQueries], SCOUT_QUERIES);
});

test('one Australian edition, monetised through Amazon', () => {
  assert.equal(SLEEKDROPS_PROFILE.monetisation, 'amazon');
  assert.deepEqual(
    SLEEKDROPS_PROFILE.editions.map((e) => [e.id, e.timeZone, e.currency, e.locale]),
    [[SLEEKDROPS_AU_EDITION_ID, 'Australia/Sydney', HOME_CURRENCY, 'en-AU']],
  );
  assert.equal(SLEEKDROPS_PROFILE.editions[0].complianceFooter, '');
});

test('the publish target names environment variables, never values', () => {
  for (const name of Object.values(SLEEKDROPS_PROFILE.publishTarget)) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/);
  }
});
