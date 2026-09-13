import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTI_SLOP_RULES,
  authorVoiceBrief,
  EDITORIAL_RULES,
  editorialAngleBrief,
  GEO_RULES,
  operatorBrief,
} from './context.js';
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
  byline: 'home',
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

test('a voice brief carries one beat, never the roster', () => {
  // The rule this protects: hand a writer four voices and it writes the
  // average of them, which is the single house voice the beats exist to
  // break up.
  const home = authorById('home');
  assert.ok(home);
  const brief = authorVoiceBrief(home);
  assert.match(brief, /publishes as SleekDrops Editorial Team - Home \(beat id: home\)/);
  assert.ok(brief.includes(home.voice.specimen), 'the specimen is what the draft is matched against');
  assert.match(brief, /Never reuse its facts/, 'a specimen is texture, not a source');
  for (const other of AUTHORS.filter((a) => a.id !== 'home')) {
    assert.ok(!brief.includes(other.voice.specimen), `${other.id}'s specimen leaked into the prompt`);
  }
});

// The shared blocks reach the writer, the editor and the reviewer. While they
// carried one universal skeleton, every piece on the site was written to it -
// which is the sameness the structure library exists to break.

test('the GEO rules ask for a passage budget, not a block under every heading', () => {
  assert.match(GEO_RULES, /EXTRACTABLE ANSWERS, on a budget/);
  assert.match(GEO_RULES, /The piece's own shape says how\s+many and how long/);
  assert.doesNotMatch(GEO_RULES, /Every major H2 opens/);
  // Still honest for a piece with no shape recorded: the citability principle
  // survives, it is the uniform realisation of it that does not.
  assert.match(GEO_RULES, /where no shape is recorded, take it as three or\s+four/);
  assert.match(GEO_RULES, /CLAIM \+ EVIDENCE, always paired/);
  assert.match(GEO_RULES, /NAME ENTITIES/);
  assert.match(GEO_RULES, /RECENCY/);
});

test('the FAQ rule defers to the shape but still holds where the schema is built', () => {
  assert.match(GEO_RULES, /FAQ where the piece's shape carries one/);
  assert.match(GEO_RULES, /where a shape requires one it is not\s+optional/);
  assert.match(GEO_RULES, /"## FAQ" with "### Question\?" headings/);
  assert.doesNotMatch(GEO_RULES, /the FAQ is mandatory, not optional/);
});

test('no shared block prescribes a "how we picked" section on every piece', () => {
  assert.doesNotMatch(EDITORIAL_RULES, /a "how we picked" section/);
  assert.match(EDITORIAL_RULES, /is not a section every\s+article owes the reader/);
});

test('the voice rules name the house skeleton as a thing not to build', () => {
  assert.match(ANTI_SLOP_RULES, /NEVER BUILD THE HOUSE SKELETON/);
  assert.match(ANTI_SLOP_RULES, /No identical block under every heading/);
  assert.match(ANTI_SLOP_RULES, /No section that fires by reflex/);
});
