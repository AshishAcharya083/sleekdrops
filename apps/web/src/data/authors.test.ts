import { test } from 'node:test';
import assert from 'node:assert/strict';

import { beats, EDITORIAL_TEAM, getAuthor, listAuthors, listBeats } from './authors.ts';

test('the site publishes under one accountable byline, tagged with a beat', () => {
  // A named desk or a "staff" byline promises a staffed team behind it. There
  // is one entity here, on every piece, and the beat is a label on it.
  assert.deepEqual(
    listAuthors().map((a) => a.name),
    ['SleekDrops Editorial Team'],
  );
  for (const beat of listBeats()) {
    assert.doesNotMatch(beat.label, /desk|staff/i, `"${beat.label}" implies a team of its own`);
  }
});

test('any stored author id resolves to the team byline and its beat tag', () => {
  for (const id of ['mira', 'theo', 'aiko', 'lina', 'sam', 'beatriz', 'desk', 'unknown']) {
    const author = getAuthor(id);
    assert.equal(author.id, EDITORIAL_TEAM.id, `${id} must publish under the one byline`);
    assert.equal(author.name, EDITORIAL_TEAM.name);
    assert.equal(author.beat, undefined, `${id} has no specialist beat to claim`);
    assert.equal(author.voice, beats.desk.voice, `${id} falls back to the house voice`);
  }

  const tech = getAuthor('tech');
  assert.equal(tech.id, EDITORIAL_TEAM.id, 'the beat is a tag, never a second byline');
  assert.equal(tech.beat, 'Tech');
  assert.equal(tech.focus, beats.tech.focus);
  assert.equal(tech.voice, beats.tech.voice);
});

test('each beat carries a distinct voice specimen for the pipeline to write to', () => {
  const seen = new Set<string>();
  for (const beat of listBeats()) {
    for (const field of ['rhythm', 'vocabulary', 'cares', 'specimen'] as const) {
      const value = beat.voice[field];
      assert.ok(value.length > 40, `${beat.id}.voice.${field} is too thin to write to`);
      assert.ok(!seen.has(value), `${beat.id}.voice.${field} is shared with another beat`);
      seen.add(value);
    }
  }
});
