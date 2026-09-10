import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authors, getAuthor, listAuthors } from './authors.ts';

test('every public byline is an accountable desk, never a person', () => {
  const ids = listAuthors().map((a) => a.id);
  assert.deepEqual(ids, ['desk', 'tech-desk', 'home-desk', 'value-desk']);
  for (const author of listAuthors()) {
    assert.match(author.name, /^SleekDrops /, `${author.id} must be a desk byline`);
    assert.equal(author.role, 'Editorial team');
  }
});

test('legacy post ids resolve to the general editorial desk byline', () => {
  for (const id of ['mira', 'theo', 'aiko', 'lina', 'sam', 'beatriz']) {
    assert.equal(getAuthor(id), authors.desk);
  }
  assert.equal(getAuthor('desk'), authors.desk);
  assert.equal(getAuthor('tech-desk'), authors['tech-desk']);
  assert.throws(() => getAuthor('unknown'), /Unknown author id/);
});

test('each desk carries a distinct voice specimen for the pipeline to write to', () => {
  const seen = new Set<string>();
  for (const author of listAuthors()) {
    for (const field of ['rhythm', 'vocabulary', 'cares', 'specimen'] as const) {
      const value = author.voice[field];
      assert.ok(value.length > 40, `${author.id}.voice.${field} is too thin to write to`);
      assert.ok(!seen.has(value), `${author.id}.voice.${field} is shared with another desk`);
      seen.add(value);
    }
  }
});
