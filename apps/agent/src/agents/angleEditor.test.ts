// normaliseAngle is the guard between the angle stage's JSON and four
// downstream prompts, the byline the article publishes under, and the admin
// panel. Two of its rules are editorial policy rather than shape-checking - a
// take with no thesis behind it is not defensible, and information gain is
// only gain against a page the keyword stage actually read - so both are
// pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAngle } from './angleEditor.js';
import type { EditorialAngle } from '../pipeline/types.js';

const opts = {
  postType: 'guide',
  category: 'Home',
  competitorUrls: ['https://choice.com.au/vacuums', 'https://canstarblue.com.au/vacuums'],
};

/** A well-formed angle, for the fields a test isn't exercising. */
function angle(overrides: Partial<EditorialAngle> = {}): EditorialAngle {
  return {
    thesis: 'The Dyson is the wrong buy above A$1,000 and the Shark is the one to get.',
    reader: 'Someone replacing a corded vacuum in a two-bedroom flat with no carpet',
    defensible: true,
    contrarianTake: 'The machine every roundup ranks first is the one owners replace in year two.',
    weakness: '',
    informationGain: [
      {
        claim: 'The clutch fails inside 12 months on a recurring basis.',
        absentFrom: 'https://choice.com.au/vacuums',
        evidence: '37 of 412 ProductReview entries, 2026-03',
      },
    ],
    shape: 'failure-led',
    shapeRationale: 'The failure data is the only thing the top three do not have.',
    byline: 'home',
    bylineRationale: 'A durability argument about a household appliance.',
    ...overrides,
  };
}

test('a well-formed angle passes through intact', () => {
  const out = normaliseAngle(angle(), opts);
  assert.equal(out.shape, 'failure-led');
  assert.equal(out.defensible, true);
  assert.equal(out.byline, 'home');
  assert.equal(out.informationGain.length, 1);
  assert.equal(out.weakness, '');
});

test('an unknown shape falls back on the post type, not on one house shape', () => {
  const bad = { shape: 'inverted-pyramid' as EditorialAngle['shape'] };
  assert.equal(normaliseAngle(angle(bad), opts).shape, 'segmented-buyers');
  assert.equal(
    normaliseAngle(angle(bad), { ...opts, postType: 'roundup' }).shape,
    'ranked-list',
  );
  assert.equal(
    normaliseAngle(angle(bad), { ...opts, postType: 'article' }).shape,
    'question-led',
  );
  assert.equal(
    normaliseAngle(angle(bad), { ...opts, postType: 'explainer' }).shape,
    'question-led',
    'an unrecognised post type still gets a shape',
  );
});

test('a shape borrowed from Object.prototype is not a shape', () => {
  // `'constructor' in ARTICLE_SHAPES` is true, and a shape that resolved to a
  // function would be rendered into four prompts as one.
  for (const shape of ['constructor', '__proto__', 'toString']) {
    const out = normaliseAngle(angle({ shape: shape as EditorialAngle['shape'] }), opts);
    assert.equal(out.shape, 'segmented-buyers');
  }
});

test('an unknown byline falls back to the beat that owns the category', () => {
  assert.equal(normaliseAngle(angle({ byline: 'mira' }), opts).byline, 'home');
  assert.equal(
    normaliseAngle(angle({ byline: '' }), { ...opts, category: 'Tech' }).byline,
    'tech',
  );
  assert.equal(
    normaliseAngle(angle({ byline: 'nobody' }), { ...opts, category: 'Sport' }).byline,
    'desk',
    'a category no beat owns falls back to the house voice',
  );
});

test('a take with no thesis behind it is not recorded as defensible', () => {
  const out = normaliseAngle(angle({ thesis: '   ', defensible: true }), opts);
  assert.equal(out.defensible, false);
  assert.equal(out.contrarianTake, '', 'a take without a thesis is not carried downstream');
  assert.match(out.weakness, /no thesis/);
});

test('an empty contrarian take is recorded as no take, whatever the model claimed', () => {
  const out = normaliseAngle(angle({ contrarianTake: '', defensible: true }), opts);
  assert.equal(out.defensible, false);
  assert.match(out.weakness, /No take beyond what the top results already say/);
});

test('a declared non-defensible angle keeps the reason it gives', () => {
  const out = normaliseAngle(
    angle({ defensible: false, contrarianTake: 'invented take', weakness: 'No owner complaints.' }),
    opts,
  );
  assert.equal(out.defensible, false);
  assert.equal(out.contrarianTake, '', 'the take is dropped, not published alongside the refusal');
  assert.equal(out.weakness, 'No owner complaints.');
});

test('information gain against a page we never read loses the attribution, not the claim', () => {
  const out = normaliseAngle(
    angle({
      informationGain: [
        { claim: 'Owners report the battery halving.', absentFrom: 'https://invented.example/x', evidence: 'e' },
        { claim: '', absentFrom: 'https://choice.com.au/vacuums', evidence: 'e' },
      ],
    }),
    opts,
  );
  assert.equal(out.informationGain.length, 1, 'a claim-less entry is dropped entirely');
  assert.equal(out.informationGain[0].absentFrom, '');
  assert.equal(out.informationGain[0].claim, 'Owners report the battery halving.');
});

test('a fragment comes back as a complete record, never as undefined fields', () => {
  const out = normaliseAngle({}, opts);
  assert.equal(out.thesis, '');
  assert.equal(out.reader, '');
  assert.equal(out.defensible, false);
  assert.ok(Array.isArray(out.informationGain));
  assert.equal(out.informationGain.length, 0);
  assert.equal(out.shape, 'segmented-buyers');
  assert.equal(out.byline, 'home');
  assert.ok(out.weakness.length > 0, 'the panel always has something to show');
});

test('a non-object reply is normalised rather than thrown at the pipeline', () => {
  for (const raw of [null, 'a thesis', ['a thesis'], 42]) {
    const out = normaliseAngle(raw, opts);
    assert.equal(out.defensible, false);
    assert.equal(out.thesis, '');
  }
});
