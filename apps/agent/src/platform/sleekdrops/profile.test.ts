// The SleekDrops seed is the text its prompts were built from, moved verbatim.
// The prompt snapshots pin what those prompts render; this pins the seed to
// the constants and catalogues that still exist beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { promptContextFromSeed, siteContext } from '../../agents/context.js';
import { scoutQueries } from '../../agents/topicScout.js';
import { LIBRARY_SHAPES } from '../../content/shapeLibrary.js';
import { BYLINE_NAME, CATEGORIES, HOME_CURRENCY, POST_TYPES } from '../../content/contract.js';
import { PLATFORM_SEEDS } from '../profiles.js';
import { SLEEKDROPS_PLATFORM_ID, sleekdropsSeed } from './index.js';

const { platform, editions } = sleekdropsSeed;
const ctx = promptContextFromSeed(sleekdropsSeed, 'au');

/** The searches the pinned scout prompt ran, in order. */
function scoutQueriesInSnapshot(): string[] {
  const snapshot = readFileSync(
    new URL('../../agents/__snapshots__/prompts/scout.txt', import.meta.url),
    'utf8',
  );
  return [...snapshot.matchAll(/^### Search: "([^"]*)"$/gm)].map((m) => m[1]);
}

test('brand text and audience are the site context, verbatim and in order', () => {
  assert.ok(siteContext(ctx).startsWith(`${platform.brandText} ${platform.audience}\n`));
});

test('byline, categories, post types, shapes and scout queries are the current ones', () => {
  assert.equal(platform.id, SLEEKDROPS_PLATFORM_ID);
  assert.equal(platform.bylineName, BYLINE_NAME);
  assert.deepEqual(platform.categories, [...CATEGORIES]);
  assert.deepEqual(platform.postTypes, [...POST_TYPES]);
  assert.deepEqual(
    platform.articleShapes,
    LIBRARY_SHAPES.map((shape) => shape.id),
  );
  const queries = scoutQueriesInSnapshot();
  assert.equal(queries.length, 6);
  assert.deepEqual(scoutQueries(ctx), queries);
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
