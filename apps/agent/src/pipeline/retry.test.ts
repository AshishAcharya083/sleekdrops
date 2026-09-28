// The derivations behind the retry API, in isolation: which stages a retry
// leaves out of date, what the stage body param accepts, and how a session log
// becomes the attempt history the panel renders. Everything here is pure - the
// database side is retryStage.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';

const { groupAttempts, outOfDateStages, parseStageParam } = await import('./retry.js');
const { STAGE_ORDER } = await import('./types.js');
const { STAGE_AGENT } = await import('./runner.js');

test('the pipeline order covers exactly the stages that have an agent', () => {
  assert.deepEqual(
    STAGE_ORDER.filter((stage) => stage !== 'done'),
    Object.keys(STAGE_AGENT),
    'STAGE_ORDER and STAGE_AGENT must not drift - the first decides what is downstream',
  );
});

test('nothing is out of date until a retry marks where it restarted from', () => {
  assert.deepEqual(outOfDateStages(null, 'publish'), []);
});

test('a retry marks the stages after it, until the run re-passes them', () => {
  // Re-queued at write: everything after it still holds output built from the
  // draft that is about to be replaced.
  assert.deepEqual(outOfDateStages('write', 'write'), [
    'seo_review',
    'edit',
    'assemble',
    'image',
    'publish',
  ]);
  // The run has reached assemble, so write and seo_review have re-run.
  assert.deepEqual(outOfDateStages('write', 'assemble'), ['assemble', 'image', 'publish']);
  // Finished: the whole run has been re-passed.
  assert.deepEqual(outOfDateStages('write', 'done'), []);
});

test('the retried stage itself is not out of date once the run is past it', () => {
  assert.deepEqual(outOfDateStages('seo_review', 'seo_review'), [
    'edit',
    'assemble',
    'image',
    'publish',
  ]);
  assert.deepEqual(outOfDateStages('publish', 'publish'), []);
});

test('a marker naming a stage that no longer exists degrades to nothing stale', () => {
  assert.deepEqual(outOfDateStages('proofread', 'publish'), []);
});

test('the stage body param is validated with the messages the panel renders', () => {
  assert.deepEqual(parseStageParam('seo_review'), { ok: true, stage: 'seo_review' });
  assert.deepEqual(parseStageParam(' write '), { ok: true, stage: 'write' });
  assert.deepEqual(parseStageParam(undefined), { ok: false, error: 'stage required' });
  assert.deepEqual(parseStageParam(''), { ok: false, error: 'stage required' });
  assert.deepEqual(parseStageParam(7), { ok: false, error: 'stage required' });
  assert.deepEqual(parseStageParam('polish'), { ok: false, error: 'unknown stage "polish"' });
  assert.deepEqual(parseStageParam('done'), { ok: false, error: 'done is not a runnable stage' });
});

const session = (
  agent: string,
  attempt: number,
  startedAt: string,
  endedAt: string | null,
  kind = 'pipeline',
) => ({
  id: `${agent}-${attempt}`,
  agent,
  model: 'claude-opus-5',
  status: endedAt ? 'done' : 'running',
  summary: null,
  error: null,
  attempt,
  kind,
  cost_usd: '1.25',
  tokens_input: '100',
  tokens_output: '200',
  started_at: startedAt,
  ended_at: endedAt,
});

test('attempt history is grouped per stage in pipeline order, oldest attempt first', () => {
  const attempts = groupAttempts([
    session('seo_reviewer', 2, '2026-09-20T10:00:00.000Z', '2026-09-20T10:01:00.000Z'),
    session('writer', 1, '2026-09-20T09:00:00.000Z', '2026-09-20T09:05:00.000Z'),
    session('seo_reviewer', 1, '2026-09-20T09:10:00.000Z', '2026-09-20T09:11:00.000Z'),
  ]);

  assert.deepEqual(
    attempts.map((group) => group.stage),
    ['write', 'seo_review'],
  );
  assert.equal(attempts[0].agent, 'writer');
  assert.deepEqual(
    attempts[1].runs.map((run) => run.attempt),
    [1, 2],
  );
  assert.equal(attempts[0].runs[0].durationMs, 300_000);
  assert.equal(attempts[0].runs[0].costUsd, 1.25);
  assert.equal(attempts[0].runs[0].tokensInput, 100);
});

test('a still-running stage has no duration, and a test run is labelled as one', () => {
  const [group] = groupAttempts([
    session('writer', 1, '2026-09-20T09:00:00.000Z', null),
    session('writer', 1, '2026-09-20T09:30:00.000Z', '2026-09-20T09:31:00.000Z', 'test'),
  ]);

  assert.equal(group.runs[0].durationMs, null);
  assert.equal(group.runs[0].endedAt, null);
  assert.equal(group.runs[0].kind, 'pipeline');
  assert.equal(group.runs[1].kind, 'test');
});

test('a session from an agent that runs no article stage is left out of the board', () => {
  assert.deepEqual(
    groupAttempts([session('topic_scout', 1, '2026-09-20T09:00:00.000Z', '2026-09-20T09:01:00.000Z')]),
    [],
  );
});
