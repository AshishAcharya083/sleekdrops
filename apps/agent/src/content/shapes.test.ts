import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPES,
  describeShapeSelection,
  passageBudgetRule,
  selectShape,
  shapeById,
  shapesForPostType,
  structureBrief,
} from './shapes.js';
import type { ArticleShape } from './shapes.js';
import { ARTICLE_SHAPES } from '../pipeline/types.js';
import { POST_TYPES } from './contract.js';
import type { EditorialAngle } from '../pipeline/types.js';

function anAngle(overrides: Partial<EditorialAngle> = {}): EditorialAngle {
  return {
    thesis: 'The Shark is the one to buy under A$700.',
    reader: 'Someone replacing a corded vacuum in a flat with no carpet',
    defensible: true,
    contrarianTake: 'The machine every roundup ranks first is the one owners replace in year two.',
    weakness: '',
    informationGain: [],
    shape: 'failure-led',
    shapeRationale: 'The failure data is what the top three do not have.',
    byline: 'home',
    bylineRationale: 'A durability argument about an appliance.',
    ...overrides,
  };
}

// ---------------------------------------------------------------- the library

test('every shape the angle stage can name has a structure behind it', () => {
  // The angle stage picks an id out of ARTICLE_SHAPES. An id with no library
  // entry would select nothing and silently fall through to the rotation.
  for (const id of Object.keys(ARTICLE_SHAPES)) {
    assert.ok(shapeById(id), `${id} is offered to the angle stage with no shape behind it`);
  }
  assert.equal(SHAPES.length, Object.keys(ARTICLE_SHAPES).length);
});

test('shapeById rejects anything that is not a published shape', () => {
  assert.equal(shapeById('constructor'), null);
  assert.equal(shapeById(''), null);
  assert.equal(shapeById(null), null);
  assert.equal(shapeById({ id: 'ranked-list' }), null);
});

test('every shape satisfies its own invariants', () => {
  const ids = new Set<string>();
  for (const shape of SHAPES) {
    assert.ok(!ids.has(shape.id), `duplicate shape id ${shape.id}`);
    ids.add(shape.id);
    assert.match(shape.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${shape.id} is not kebab-case`);
    assert.ok(shape.name.trim().length > 0, `${shape.id} has no name`);
    assert.ok(shape.openingStyle.trim().length > 20, `${shape.id} has no opening style`);
    assert.ok(['required', 'optional', 'omit'].includes(shape.faq), `${shape.id} faq rule`);

    const { passages, words } = shape.passageBudget;
    assert.ok(Number.isInteger(passages) && passages >= 1, `${shape.id} budgets no passages`);
    // A budget as long as the section list is the per-H2 rule again, which is
    // the uniformity this library exists to remove.
    assert.ok(passages <= 4, `${shape.id} budgets ${passages} passages - that is a template`);
    assert.ok(words.min > 0 && words.min <= words.max, `${shape.id} word range`);

    assert.ok(shape.sections.length >= 3, `${shape.id} has too few sections to be a shape`);
    assert.ok(shape.sections.some((s) => s.required), `${shape.id} has no required section`);
    assert.ok(
      shape.sections.some((s) => s.carriesAnswer),
      `${shape.id} spends a passage budget on nothing`,
    );
    assert.ok(
      shape.sections.some((s) => s.slot === 'open') && shape.sections.some((s) => s.slot === 'close'),
      `${shape.id} has no opening or no close`,
    );
    const kinds = new Set(shape.sections.map((s) => s.kind));
    assert.equal(kinds.size, shape.sections.length, `${shape.id} repeats a section kind`);
    for (const section of shape.sections) {
      assert.ok(section.label.trim().length > 0, `${shape.id}.${section.kind} has no label`);
      assert.ok(section.purpose.trim().length > 20, `${shape.id}.${section.kind} has no purpose`);
    }
    assert.ok(shape.postTypes.length > 0, `${shape.id} is offered for no post type`);
    for (const postType of shape.postTypes) {
      assert.ok(
        (POST_TYPES as readonly string[]).includes(postType),
        `${shape.id} is offered for unknown post type ${postType}`,
      );
    }
  }
});

test('the FAQ rule and the FAQ section agree in every shape', () => {
  // The two are read by different stages - the outliner reads `faq`, the
  // writer reads the running order - so a shape where they disagree emits a
  // section nothing populated, or entries nothing renders.
  for (const shape of SHAPES) {
    const section = shape.sections.find((s) => s.kind === 'faq');
    if (shape.faq === 'required') {
      assert.ok(section?.required, `${shape.id} requires an FAQ but has no required FAQ section`);
    } else if (shape.faq === 'optional') {
      // The writer is told that sections the shape does not carry do not
      // appear. A shape whose FAQ is a judgement call still has to say where
      // one would sit, or an FAQ the outline asked for has no home.
      assert.ok(section, `${shape.id} allows an FAQ but never says where it goes`);
      assert.equal(section.required, false, `${shape.id} marks an optional FAQ as required`);
    } else {
      assert.equal(section, undefined, `${shape.id} omits the FAQ but carries an FAQ section`);
    }
  }
});

test('no two shapes are the same silhouette', () => {
  // The whole point of the library. Two shapes with the same opening style and
  // the same running order are one shape with two names.
  const seen = new Map<string, string>();
  for (const shape of SHAPES) {
    const fingerprint = JSON.stringify([
      shape.openingStyle,
      shape.sections.map((s) => [s.kind, s.slot, s.carriesAnswer]),
    ]);
    const clash = seen.get(fingerprint);
    assert.equal(clash, undefined, `${shape.id} is the same silhouette as ${clash}`);
    seen.set(fingerprint, shape.id);
  }
});

test('every post type is offered several shapes', () => {
  for (const postType of POST_TYPES) {
    const offered = shapesForPostType(postType);
    assert.ok(offered.length >= 3, `${postType} is offered only ${offered.length} shape(s)`);
    for (const shape of offered) assert.ok(shape.postTypes.includes(postType));
  }
});

test('an unknown post type still gets the whole library, not one default', () => {
  assert.equal(shapesForPostType('newsletter').length, SHAPES.length);
});

// --------------------------------------------------------------- selection

test('the angle stage shape is the decision of record', () => {
  const shape = selectShape({
    postType: 'guide',
    angle: anAngle({ shape: 'failure-led' }),
    winningFormat: 'ranked listicle',
    intent: 'Transactional',
  });
  assert.equal(shape.id, 'failure-led');
  assert.equal(shape.selectedBy, 'angle');
});

test('selection is deterministic for every post type', () => {
  for (const postType of POST_TYPES) {
    const input = { postType, angle: null, winningFormat: null, intent: null, seed: 'article-1' };
    const first = selectShape(input);
    assert.deepEqual(selectShape(input), first);
    assert.deepEqual(selectShape({ ...input }), first);
    assert.ok(first.postTypes.includes(postType));
  }
});

test('an angle shape this post type is not offered falls through to the SERP read', () => {
  // 'segmented-buyers' is a guide/roundup shape. A news article that came back
  // with it takes the format the SERP rewards instead of a structure whose
  // sections that post type cannot fill.
  const shape = selectShape({
    postType: 'article',
    angle: anAngle({ shape: 'segmented-buyers' }),
    winningFormat: 'Head-to-head comparison',
  });
  assert.equal(shape.id, 'head-to-head');
  assert.equal(shape.selectedBy, 'format');
});

test('the winning format picks the shape when there is no angle', () => {
  const cases: Array<[string, string]> = [
    ['Ranked listicle with a table', 'ranked-list'],
    ['product vs product comparison', 'head-to-head'],
    ['long-form buying guide', 'segmented-buyers'],
    ['how-to explainer', 'question-led'],
    ['running costs breakdown', 'cost-of-ownership'],
  ];
  for (const [winningFormat, expected] of cases) {
    const shape = selectShape({ postType: 'guide', angle: null, winningFormat });
    assert.equal(shape.id, expected, `"${winningFormat}" should select ${expected}`);
    assert.equal(shape.selectedBy, 'format');
  }
});

test('a format fragment has to land on a whole word, not inside one', () => {
  // "vs" sits inside "TVs", "fix" inside "fixture", "value" inside "valuable".
  // A substring read sends a listicle of many products to a shape whose
  // running order argues two contenders axis by axis, and the SEO reviewer
  // then files the format mismatch and burns a revision round on it.
  const cases: Array<[string, string]> = [
    ['Ranked listicle of the best TVs', 'ranked-list'],
    ['best OLED TVs roundup', 'ranked-list'],
    ['Best SUVs list', 'ranked-list'],
    ['Top 10 EVs', 'ranked-list'],
  ];
  for (const [winningFormat, expected] of cases) {
    const shape = selectShape({ postType: 'guide', angle: null, winningFormat });
    assert.equal(shape.id, expected, `"${winningFormat}" should select ${expected}`);
    assert.equal(shape.selectedBy, 'format');
  }
});

test('a whole-word format fragment still matches plurals and hyphenated fragments', () => {
  const cases: Array<[string, string]> = [
    ['expert reviews', 'verdict-first'],
    ['buying guides', 'segmented-buyers'],
    ['running costs breakdown', 'cost-of-ownership'],
    ['head-to-head', 'head-to-head'],
    ['how-to', 'question-led'],
  ];
  for (const [winningFormat, expected] of cases) {
    const shape = selectShape({ postType: 'guide', angle: null, winningFormat });
    assert.equal(shape.id, expected, `"${winningFormat}" should select ${expected}`);
  }
});

test('a format the library does not name falls through rather than half-matching', () => {
  // Every one of these contains a fragment as a substring: "single-serve",
  // "fixture", "valuable", "TVs".
  for (const winningFormat of ['single-serve fixture guide', 'valuable TVs writeup']) {
    const shape = selectShape({ postType: 'guide', angle: null, winningFormat, intent: null });
    assert.equal(shape.selectedBy, 'rotation', `"${winningFormat}" matched a shape on a substring`);
  }
});

test('the search intent decides when the format says nothing recognisable', () => {
  const shape = selectShape({
    postType: 'guide',
    angle: null,
    winningFormat: 'editorial page',
    intent: 'Commercial Investigation',
  });
  assert.equal(shape.id, 'segmented-buyers');
  assert.equal(shape.selectedBy, 'intent');
});

test('no plan and no angle still selects, and spreads across the library', () => {
  // The state of every article queued before the keyword and angle stages
  // existed. One default for all of them would rebuild the uniform skeleton.
  const picked = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const shape = selectShape({
      postType: 'guide',
      angle: null,
      winningFormat: null,
      intent: null,
      seed: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`,
    });
    assert.equal(shape.selectedBy, 'rotation');
    assert.ok(shape.postTypes.includes('guide'));
    picked.add(shape.id);
  }
  assert.ok(picked.size >= 3, `the fallback collapsed onto ${[...picked].join(', ')}`);
});

test('selection without a seed still returns a shape for the post type', () => {
  for (const postType of POST_TYPES) {
    const shape = selectShape({ postType, angle: null });
    assert.ok(shape.postTypes.includes(postType));
  }
});

test('an angle whose shape is not a published one is ignored, not trusted', () => {
  const angle = { ...anAngle(), shape: 'constructor' } as unknown as EditorialAngle;
  const shape = selectShape({ postType: 'roundup', angle, winningFormat: 'Top 10 list' });
  assert.equal(shape.id, 'ranked-list');
  assert.equal(shape.selectedBy, 'format');
});

// ------------------------------------------------------- the prompt contract

test('structureBrief carries the opening style, the order and the budget', () => {
  const shape = shapeById('ranked-list') as ArticleShape;
  const brief = structureBrief(shape);
  assert.match(brief, /"Ranked roundup" shape \(ranked-list\)/);
  assert.match(brief, /The ranking at a glance/);
  assert.match(brief, /extractable answer/);
  assert.match(brief, /FAQ: required/);
  // The running order is open → body → close whatever order the library lists
  // the sections in, because that order is what the writer follows.
  const order = ['[open]', '[body]', '[close]'].map((slot) => brief.indexOf(slot));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('structureBrief tells a shape that omits the FAQ not to add one', () => {
  const brief = structureBrief(shapeById('question-led') as ArticleShape);
  assert.match(brief, /FAQ: omitted for this shape/);
  assert.ok(!/FAQ: required/.test(brief));
});

test('structureBrief is empty when no shape was recorded', () => {
  assert.equal(structureBrief(null), '');
  assert.equal(structureBrief(undefined), '');
});

test('the passage budget rule states a total, never a per-heading rule', () => {
  for (const shape of SHAPES) {
    const rule = passageBudgetRule(shape);
    assert.match(rule, new RegExp(`${shape.passageBudget.passages} extractable answer`));
    assert.match(
      rule,
      new RegExp(`${shape.passageBudget.words.min}-${shape.passageBudget.words.max} words`),
    );
    assert.match(rule, /under every heading is a template/);
  }
});

test('describeShapeSelection names the shape and where it came from', () => {
  const shape = selectShape({ postType: 'guide', angle: anAngle({ shape: 'head-to-head' }) });
  assert.equal(describeShapeSelection(shape), 'Head-to-head (head-to-head) from the angle');
});
