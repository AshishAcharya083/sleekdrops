import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorVoiceBrief, editorialAngleBrief, operatorBrief } from './context.js';
import { AUTHORS, authorById } from '../content/contract.js';
import type { EditorialAngle, TopicRow } from '../pipeline/types.js';

const baseTopic: TopicRow = {
  id: '00000000-0000-0000-0000-000000000000',
  title: 'Best budget standing desks',
  category: 'Home',
  post_type: 'guide',
  angle: null,
  keywords: [],
  why_trending: null,
  sources: [],
  status: 'draft',
  source: 'manual',
  instructions: null,
  research_notes: [],
  hero_image_url: null,
  hero_alt: null,
};

test('operatorBrief is empty for scouted topics', () => {
  const topic: TopicRow = { ...baseTopic, source: 'scout', instructions: 'ignored', research_notes: [] };
  assert.equal(operatorBrief(topic), '');
});

test('operatorBrief is empty for a null topic', () => {
  assert.equal(operatorBrief(null), '');
});

test('operatorBrief is empty when a manual topic carries no brief', () => {
  const topic: TopicRow = { ...baseTopic, instructions: '   ', research_notes: [{ name: 'a.md', content: '  ' }] };
  assert.equal(operatorBrief(topic), '');
});

test('operatorBrief includes instructions and non-empty references, numbered', () => {
  const topic: TopicRow = {
    ...baseTopic,
    instructions: 'Focus on sub-$400 AUD options.',
    research_notes: [
      { name: 'my-picks.md', content: 'Omidesk Pro is rock solid.' },
      { name: 'blank.md', content: '   ' },
      { name: 'facts.md', content: 'FlexiSpot E7 has the best warranty.' },
    ],
  };
  const brief = operatorBrief(topic);
  assert.match(brief, /OPERATOR BRIEF/);
  assert.match(brief, /Focus on sub-\$400 AUD options\./);
  assert.match(brief, /reference 1: my-picks\.md/);
  assert.match(brief, /Omidesk Pro is rock solid\./);
  // Blank reference dropped, so facts.md becomes reference 2 (not 3).
  assert.match(brief, /reference 2: facts\.md/);
  assert.ok(!brief.includes('blank.md'));
});

const angle: EditorialAngle = {
  thesis: 'The Dyson is the wrong buy above A$1,000.',
  reader: 'Someone replacing a corded vacuum in a flat with no carpet',
  defensible: true,
  contrarianTake: 'The machine every roundup ranks first is the one owners replace in year two.',
  weakness: '',
  informationGain: [
    { claim: 'The clutch fails inside 12 months.', absentFrom: 'https://choice.com.au/v', evidence: '37 of 412 reviews' },
  ],
  shape: 'failure-led',
  shapeRationale: 'The failure data is what the top three do not have.',
  byline: 'home-desk',
  bylineRationale: 'A durability argument about an appliance.',
};

test('editorialAngleBrief is empty when no angle was recorded', () => {
  assert.equal(editorialAngleBrief(null), '');
});

test('editorialAngleBrief carries the thesis, the gain and the shape as an instruction', () => {
  const brief = editorialAngleBrief(angle);
  assert.match(brief, /Thesis: The Dyson is the wrong buy above A\$1,000\./);
  assert.match(brief, /The clutch fails inside 12 months\./);
  assert.match(brief, /absent from https:\/\/choice\.com\.au\/v/);
  // The shape has to arrive as an instruction, not as an id nobody can act on.
  assert.match(brief, /Structural shape: failure-led - Lead with what goes wrong/);
});

test('a piece with no defensible take tells the writer so, in as many words', () => {
  const brief = editorialAngleBrief({
    ...angle,
    defensible: false,
    contrarianTake: '',
    weakness: 'The dossier carried no owner complaints.',
  });
  assert.match(brief, /NO DEFENSIBLE CONTRARIAN TAKE/);
  assert.match(brief, /The dossier carried no owner complaints\./);
  assert.match(brief, /Do not manufacture one/);
  assert.doesNotMatch(brief, /The machine every roundup ranks first/);
});

test('a voice brief carries one desk, never the roster', () => {
  // The rule this protects: hand a writer four voices and it writes the
  // average of them, which is the single house voice the bylines exist to
  // break up.
  const home = authorById('home-desk');
  assert.ok(home);
  const brief = authorVoiceBrief(home);
  assert.match(brief, /published as SleekDrops Home Desk \(home-desk\)/);
  assert.ok(brief.includes(home.voice.specimen), 'the specimen is what the draft is matched against');
  assert.match(brief, /Never reuse its facts/, 'a specimen is texture, not a source');
  for (const other of AUTHORS.filter((a) => a.id !== 'home-desk')) {
    assert.ok(!brief.includes(other.voice.specimen), `${other.id}'s specimen leaked into the prompt`);
  }
});
