// Posting is organic only: the Graph client refuses any path outside the Page,
// post and token endpoints the adapter uses, so no ad or boost can be created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const { isOrganicGraphPath } = await import('./facebook.js');

test('the organic Page and post endpoints are allowed', () => {
  for (const path of [
    'me',
    'me/accounts',
    'debug_token',
    'oauth/access_token',
    '1234567890/feed',
    '1234567890/photos',
    '1234567890_987654321',
    '1234567890_987654321/comments',
    '1234567890_987654321/insights',
  ]) {
    assert.ok(isOrganicGraphPath(path), path);
  }
});

test('ads, boosts and promotions are not', () => {
  for (const path of [
    'act_1234567890/ads',
    'act_1234567890/adcreatives',
    'act_1234567890',
    '1234567890_987654321/promotions',
    '1234567890/promotable_posts',
    '1234567890/ads_posts',
    '1234567890/feed/extra',
  ]) {
    assert.equal(isOrganicGraphPath(path), false, path);
  }
});
