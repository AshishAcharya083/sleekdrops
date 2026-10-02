import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getArticleShapes,
  getPostTypes,
  isCatalogueShape,
  POST_TYPE_CATALOGUE,
  SHAPE_CATALOGUE,
  shapeById,
} from './catalogue.js';
import { promptContextFromSeed } from '../agents/context.js';
import { sleekdropsSeed } from '../platform/sleekdrops/index.js';
import type { Platform } from '../platform/types.js';

const { platform: sleekdrops } = promptContextFromSeed(sleekdropsSeed, 'au');

test('SleekDrops selects exactly the post types and shapes it always had, in order', () => {
  assert.deepEqual(
    getPostTypes(sleekdrops).map((type) => type.id),
    ['article', 'guide', 'roundup'],
  );
  assert.deepEqual(
    getArticleShapes(sleekdrops).map((shape) => shape.id),
    [
      'verdict-first',
      'segmented-buyers',
      'head-to-head',
      'failure-led',
      'cost-of-ownership',
      'question-led',
      'ranked-list',
    ],
  );
});

test('a platform gets its subset, in its own order', () => {
  const narrow: Platform = {
    ...sleekdrops,
    postTypes: ['guide', 'article'],
    articleShapes: ['question-led', 'head-to-head'],
  };
  assert.deepEqual(getPostTypes(narrow).map((type) => type.id), ['guide', 'article']);
  assert.deepEqual(getArticleShapes(narrow).map((shape) => shape.id), ['question-led', 'head-to-head']);
});

test('an id missing from the catalogue throws, naming the platform and the id', () => {
  assert.throws(
    () => getPostTypes({ ...sleekdrops, postTypes: ['review'] }),
    /platform sleekdrops selects post type "review", which is not in the catalogue/,
  );
  assert.throws(
    () => getArticleShapes({ ...sleekdrops, articleShapes: ['listicle'] }),
    /platform sleekdrops selects article shape "listicle", which is not in the catalogue/,
  );
});

test('every catalogue entry has a unique id and a description to print', () => {
  for (const catalogue of [POST_TYPE_CATALOGUE, SHAPE_CATALOGUE]) {
    const ids = catalogue.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const entry of catalogue) assert.ok(entry.description.trim().length > 20, entry.id);
  }
});

test('shape lookups only answer for catalogue ids', () => {
  assert.equal(isCatalogueShape('failure-led'), true);
  for (const id of ['constructor', '__proto__', '', null, { id: 'failure-led' }]) {
    assert.equal(isCatalogueShape(id), false);
    assert.equal(shapeById(id), null);
  }
});

test('a looked-up entry is a copy, so a caller cannot rewrite the catalogue', () => {
  const shape = shapeById('failure-led');
  assert.ok(shape);
  shape.name = 'changed';
  assert.notEqual(shapeById('failure-led')?.name, 'changed');
  const [postType] = getPostTypes(sleekdrops);
  postType.description = 'changed';
  assert.notEqual(getPostTypes(sleekdrops)[0].description, 'changed');
});
