import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authors, getAuthor, listAuthors } from './authors.ts';

test('the public author registry exposes only the SleekDrops Editorial Desk', () => {
  assert.deepEqual(listAuthors(), [authors.desk]);
  assert.equal(authors.desk.name, 'SleekDrops Editorial Desk');
});

test('legacy post ids resolve to the public editorial desk byline', () => {
  for (const id of ['mira', 'theo', 'aiko', 'lina', 'sam', 'beatriz']) {
    assert.equal(getAuthor(id), authors.desk);
  }
  assert.equal(getAuthor('desk'), authors.desk);
  assert.throws(() => getAuthor('unknown'), /Unknown author id/);
});
