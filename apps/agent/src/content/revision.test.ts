// What a requalification is allowed to claim about itself.
//
// Two failures are being tested for, and they pull in opposite directions. A
// rebuild that genuinely replaced the page and says nothing about it leaves the
// reader unable to tell an old article from a new one. A rebuild that moved
// nothing and stamps today's date anyway is the artificial freshening Google's
// helpful-content guidance calls out by name - and a pipeline that requalifies
// by the button would do it at scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { frontmatterSchema } from './contract.js';
import { describeRevision } from './revision.js';

const LIVE =
  '## The picks\n\nThe [Shark Detect Pro](/go/shark-detect-pro) is the one we recommend, ' +
  'and the [Dyson V15 Detect](/go/dyson-v15-detect) is the premium option.';

const REBUILT =
  '## What breaks first\n\nBrush bars fail before batteries do. The ' +
  '[Shark Detect Pro](/go/shark-detect-pro) survives that; the ' +
  '[Dyson V15 Detect](/go/dyson-v15-detect) does not.';

const picks = (...slugs: string[]) =>
  slugs.map((goSlug) => ({ goSlug, name: goSlug.split('-').join(' ') }));

test('a rewritten body earns a fresh date and says what the picks are', () => {
  const revision = describeRevision({
    liveBody: LIVE,
    body: REBUILT,
    picks: [
      { name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' },
      { name: 'Dyson V15 Detect', goSlug: 'dyson-v15-detect' },
    ],
    sourceCount: 12,
  });

  assert.equal(revision.substantial, true);
  assert.equal(
    revision.note,
    'Rewritten from new research against 12 sources. The picks are unchanged: ' +
      'Shark Detect Pro and Dyson V15 Detect.',
  );
});

test('a rebuild that moved nothing does not claim an update', () => {
  // The whole point: republishing the same page at the same address is not
  // news, and dating it as though it were is the negative signal.
  const revision = describeRevision({
    liveBody: LIVE,
    body: LIVE,
    picks: picks('shark-detect-pro', 'dyson-v15-detect'),
    sourceCount: 9,
  });

  assert.equal(revision.substantial, false);
  assert.equal(revision.note, null);
});

test('a body that differs only in whitespace and emphasis is the same page', () => {
  const cosmetic = LIVE.replace('## The picks', '##   The **picks**').replace('\n\n', '\n\n\n');
  const revision = describeRevision({
    liveBody: LIVE,
    body: cosmetic,
    picks: picks('shark-detect-pro', 'dyson-v15-detect'),
    sourceCount: 9,
  });

  assert.equal(revision.substantial, false);
});

test('a swapped pick is named on both sides', () => {
  const revision = describeRevision({
    liveBody: LIVE,
    body: REBUILT.replace(
      '[Dyson V15 Detect](/go/dyson-v15-detect)',
      '[Ecovacs Deebot T30](/go/ecovacs-deebot-t30)',
    ),
    picks: [
      { name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' },
      { name: 'Ecovacs Deebot T30 Omni', goSlug: 'ecovacs-deebot-t30' },
    ],
    sourceCount: 12,
  });

  assert.deepEqual(revision.added, ['Ecovacs Deebot T30 Omni']);
  assert.deepEqual(revision.dropped, ['Dyson V15 Detect']);
  assert.match(revision.note!, /Swapped the Dyson V15 Detect for the Ecovacs Deebot T30 Omni\.$/);
});

test('a pick that only went one way is reported as that', () => {
  const added = describeRevision({
    liveBody: LIVE,
    body: `${REBUILT}\n\nAlso the [Kogan 4200](/go/kogan-4200).`,
    picks: [
      { name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' },
      { name: 'Dyson V15 Detect', goSlug: 'dyson-v15-detect' },
      { name: 'Kogan 4200', goSlug: 'kogan-4200' },
    ],
    sourceCount: 1,
  });
  assert.equal(added.note, 'Rewritten from new research against 1 source. Added Kogan 4200.');

  const dropped = describeRevision({
    liveBody: LIVE,
    body: '## What breaks first\n\nOnly the [Shark Detect Pro](/go/shark-detect-pro) survives a year.',
    picks: [{ name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' }],
    sourceCount: 0,
  });
  assert.equal(dropped.note, 'Rewritten from new research. Dropped Dyson V15 Detect.');
});

test('the live page is named from its own words, not from the rebuild', () => {
  // The dropped product has no dossier row behind it any more - the only place
  // its name still exists is the anchor text the published page carries.
  const revision = describeRevision({
    liveBody: LIVE.replace('[Dyson V15 Detect]', '[Dyson V15 Detect Absolute]'),
    body: '## What breaks first\n\nOnly the [Shark Detect Pro](/go/shark-detect-pro) survives a year.',
    picks: [{ name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' }],
    sourceCount: 4,
  });

  assert.deepEqual(revision.dropped, ['Dyson V15 Detect Absolute']);
});

test('a bare /go/ mention is still a pick, named off its slug', () => {
  // Most of the corpus predates the link contract and mentions /go/ slugs with
  // no anchor around them. The slug is that product's name kebab-cased, so the
  // page still gets a readable name rather than dropping out of the comparison.
  const revision = describeRevision({
    liveBody: 'The old body mentions /go/shark-detect-pro and /go/dyson-v15-detect.',
    body: REBUILT,
    picks: [],
    sourceCount: 2,
  });

  assert.equal(revision.substantial, true);
  assert.deepEqual(revision.kept.sort(), ['Dyson V15 Detect', 'Shark Detect Pro']);
});

test('only the destinations moving is still a substantial revision', () => {
  // Same sentences, different products behind them. The prose comparison reads
  // past the link target on purpose, so the pick comparison has to catch this.
  const revision = describeRevision({
    liveBody: LIVE,
    body: LIVE.replace('/go/dyson-v15-detect', '/go/ecovacs-deebot-t30'),
    picks: [
      { name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' },
      { name: 'Ecovacs Deebot T30', goSlug: 'ecovacs-deebot-t30' },
    ],
    sourceCount: 5,
  });

  assert.equal(revision.substantial, true);
  assert.equal(revision.note, 'Rechecked against 5 sources. Swapped the Dyson V15 Detect for the Ecovacs Deebot T30.');
});

test('a note is never long enough to fail the frontmatter it rides in', () => {
  // An anchor can be a whole sentence, and eight of them would burst the
  // schema bound. Failing a full pipeline run over the update line would be
  // the wrong trade, so the line gives way instead.
  const longPicks = Array.from({ length: 8 }, (_, i) => ({
    goSlug: `product-${i}`,
    name: `A product whose marketing name runs on for a very long time indeed, number ${i}`,
  }));
  const revision = describeRevision({
    liveBody: 'Nothing here.',
    body: longPicks.map((p) => `[${p.name}](/go/${p.goSlug})`).join(' '),
    picks: longPicks,
    sourceCount: 20,
  });

  assert.ok(revision.note);
  const parsed = frontmatterSchema.shape.updateNote.safeParse(revision.note);
  assert.ok(parsed.success, `note must satisfy the frontmatter bound: ${revision.note}`);
});
