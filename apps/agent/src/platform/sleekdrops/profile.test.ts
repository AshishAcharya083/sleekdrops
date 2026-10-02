// The SleekDrops seed is the text its prompts were built from, moved verbatim.
// Until every prompt reads it from the registry, the constants it was copied
// from still exist - and the two must not drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EDITORIAL_RULES, siteContext } from '../../agents/context.js';
import { BYLINE_NAME, CATEGORIES, HOME_CURRENCY, POST_TYPES } from '../../content/contract.js';
import { ARTICLE_SHAPES } from '../../pipeline/types.js';
import { PLATFORM_SEEDS } from '../profiles.js';
import { SLEEKDROPS_PLATFORM_ID, sleekdropsSeed } from './index.js';

const { platform, editions } = sleekdropsSeed;

/** The scout's query list, read off its source: topicScout.ts keeps it module-private. */
function scoutQueriesInTopicScout(): string[] {
  const source = readFileSync(new URL('../../agents/topicScout.ts', import.meta.url), 'utf8');
  const literal = /const SCOUT_QUERIES = \[([\s\S]*?)\];/.exec(source);
  assert.ok(literal, 'topicScout.ts declares SCOUT_QUERIES');
  return [...literal[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

test('brand text and audience are the site context, verbatim and in order', () => {
  assert.ok(siteContext().startsWith(`${platform.brandText} ${platform.audience}\n`));
});

test('byline, categories, post types, shapes, rules and scout queries are the current ones', () => {
  assert.equal(platform.id, SLEEKDROPS_PLATFORM_ID);
  assert.equal(platform.bylineName, BYLINE_NAME);
  assert.deepEqual(platform.categories, [...CATEGORIES]);
  assert.deepEqual(platform.postTypes, [...POST_TYPES]);
  assert.deepEqual(platform.articleShapes, Object.keys(ARTICLE_SHAPES));
  assert.equal(platform.editorialRules, EDITORIAL_RULES);
  const [edition] = editions;
  const queries = scoutQueriesInTopicScout();
  assert.equal(queries.length, 6);
  assert.deepEqual([...platform.scoutQueries, ...edition.scoutQueries], queries);
});

test('one Australian edition, monetised through Amazon, blocking nothing', () => {
  assert.equal(platform.monetisation, 'amazon');
  assert.deepEqual(platform.blockedLinkDomains, []);
  assert.deepEqual(platform.blockedTopics, []);
  assert.deepEqual(editions, [
    {
      id: 'au',
      name: 'Australia',
      timeZone: 'Australia/Sydney',
      currency: HOME_CURRENCY,
      locale: 'en-AU',
      scoutQueries: [],
      complianceFooter: '',
    },
  ]);
});

test('the publish target names environment variables, and rebuilds by repository dispatch', () => {
  assert.deepEqual(platform.publishTarget, {
    d1DatabaseIdEnv: 'D1_DATABASE_ID',
    githubRepoEnv: 'GITHUB_REPO',
    siteUrlEnv: 'SITE_URL',
    rebuildHookEnv: null,
  });
});

test('SleekDrops is seeded, and no two seeds share a platform id', () => {
  assert.ok(PLATFORM_SEEDS.includes(sleekdropsSeed));
  const ids = PLATFORM_SEEDS.map((seed) => seed.platform.id);
  assert.equal(new Set(ids).size, ids.length);
});
