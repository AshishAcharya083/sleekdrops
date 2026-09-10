// The byline registry is the one place two apps have to agree: the pipeline
// writes to a beat's voice, and the site renders that beat as a tag on the
// team byline. A beat the site does not know about publishes under nothing,
// and a voice that drifts stops changing the prose - silently, because both
// halves keep working on their own. So the mirror is asserted, not commented.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORS, authorById, BYLINE_NAME, bylineFor, frontmatterSchema } from './contract.js';
import { beats, EDITORIAL_TEAM, listBeats } from '../../../web/src/data/authors.ts';

test('the site publishes under one byline, and the beat is a tag on it', () => {
  assert.equal(EDITORIAL_TEAM.name, BYLINE_NAME);
  assert.equal(bylineFor(AUTHORS[0]), BYLINE_NAME, 'the house voice adds no tag');
  const tech = authorById('tech');
  assert.ok(tech);
  assert.equal(bylineFor(tech), 'SleekDrops Editorial Team - Tech');
  // A named desk or a "staff" byline promises a staffed team behind it.
  for (const author of AUTHORS) {
    assert.doesNotMatch(author.label, /desk|staff/i, `"${author.label}" implies a team of its own`);
  }
});

test('the beat voices the pipeline writes to are the ones the site renders', () => {
  assert.deepEqual(
    AUTHORS.map((a) => ({ id: a.id, label: a.label, voice: a.voice })),
    listBeats().map((b) => ({ id: b.id, label: b.label, voice: b.voice })),
  );
  assert.deepEqual(Object.keys(beats), AUTHORS.map((a) => a.id));
});

test('a beat id the site cannot render never reaches frontmatter', () => {
  // The site falls back to the house voice for an id it does not know, which
  // is the right behaviour for a published post but the wrong one for an
  // assembly: a byline nobody chose would ship without anyone noticing.
  assert.equal(frontmatterSchema.shape.author.safeParse('home').success, true);
  assert.equal(frontmatterSchema.shape.author.safeParse('home-desk').success, false);
});
