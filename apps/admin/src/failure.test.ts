/** What a failed card tells an operator before they open it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { failureNote } from './failure.ts';

test('a transient failure reads as "run it again"', () => {
  const note = failureNote({ status: 'failed', failure_class: 'transient', stage_attempts: 3 });
  assert.equal(note?.label, 'retry it');
  assert.equal(note?.badge, 'retry it · 3 attempts');
  assert.equal(note?.tone, 'amber');
  assert.match(note?.title ?? '', /already retried/);
});

test('a genuine failure reads as "this one is yours"', () => {
  const note = failureNote({ status: 'failed', failure_class: 'genuine', stage_attempts: 1 });
  assert.equal(note?.label, 'needs a human');
  assert.equal(note?.badge, 'needs a human', 'a first-attempt failure has no retry count to report');
  assert.equal(note?.tone, 'red');
  assert.match(note?.title ?? '', /not retried/);
});

test('a single attempt is not reported as a retry count', () => {
  const note = failureNote({ status: 'failed', failure_class: 'transient', stage_attempts: 1 });
  assert.equal(note?.badge, 'retry it');
});

test('nothing is claimed about a card that has not failed', () => {
  for (const status of ['queued', 'running', 'waiting_approval', 'done', 'cancelled']) {
    assert.equal(failureNote({ status, failure_class: 'genuine', stage_attempts: 2 }), null, status);
  }
});

test('a card that failed before the taxonomy existed says nothing new', () => {
  // Its error message is still rendered; guessing a class for it would not be.
  assert.equal(failureNote({ status: 'failed', failure_class: null, stage_attempts: 0 }), null);
  assert.equal(
    failureNote({ status: 'failed', failure_class: 'something-else', stage_attempts: 0 }),
    null,
  );
});

// The board and the panel are TSX, so their wiring is checked the way the
// other panel contracts here are: against the source.
const pipeline = readFileSync(
  fileURLToPath(new URL('./pages/Pipeline.tsx', import.meta.url)),
  'utf8',
);

// Which article binding each call site happens to hold is not the contract -
// it has been renamed once already - so the assertions below only care that
// each component is rendered with *some* article, on the board and in the panel.
const panelStart = pipeline.indexOf('function ArticlePanel(');
const board = pipeline.slice(0, panelStart);
const panel = pipeline.slice(panelStart);

const rendersWithArticle = (component: string, source: string): boolean =>
  new RegExp(`<${component}\\s+article=\\{[\\w.]+\\}\\s*/>`).test(source);

test('the board and the detail panel both carry the verdict', () => {
  assert.ok(panelStart > 0, 'the panel is still a component in this file');
  assert.ok(rendersWithArticle('FailureBadge', board), 'on the cardlet, beside the status');
  assert.ok(rendersWithArticle('FailureBadge', panel), 'and on the open card');
  assert.ok(rendersWithArticle('FailureExplainer', panel), 'spelled out above the error message');
  assert.match(pipeline, /\{article\.failure_class\} failure, \{article\.stage_attempts\}/);
});
