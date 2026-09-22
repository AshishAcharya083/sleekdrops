/**
 * The threshold scale, the stage bookkeeping and the fixed operator copy.
 *
 * Both sides of the platform apply the same two boundaries - the agent decides
 * which runs land on the Overview's stuck surface, the panel decides how a
 * cell is coloured - so a disagreement here is a run that is listed as stuck
 * and then renders as ordinary. stages.ts is pure, so unlike the rest of the
 * panel this is a real unit test rather than a source-level guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STAGE,
  DEFAULT_STAGE_BUDGET_SECONDS,
  elapsedBand,
  groupAttempts,
  isStoppable,
  isTestableStage,
  outOfDateStages,
  readTestStageResult,
  REVIEW_STALE_BANNER,
  REVIEW_STALE_REASON,
  stageBudgetLine,
  stageBudgetSeconds,
  stagesKeptBy,
  sessionBudgetSeconds,
  sessionStage,
  stagesRegeneratedBy,
  STAGE_ORDER,
  stopControlHint,
  stopControlLabel,
  stoppedNotice,
  timedOutSentence,
  UNTESTABLE_STAGE_HINT,
  type StageSession,
} from './stages.ts';

const HOUR = 3600;

test('the band boundaries are half the budget and the budget itself', () => {
  assert.equal(elapsedBand(0, HOUR), 'normal');
  assert.equal(elapsedBand(HOUR * 0.5 - 1, HOUR), 'normal', 'one second below the soft bound');
  assert.equal(elapsedBand(HOUR * 0.5, HOUR), 'warn', 'the soft bound itself is already a warning');
  assert.equal(elapsedBand(HOUR - 1, HOUR), 'warn', 'one second below the budget');
  assert.equal(elapsedBand(HOUR, HOUR), 'over', 'the budget itself is already over');
  assert.equal(elapsedBand(162120, HOUR), 'over', 'the 2702-minute session that started this');
});

test('a run the budget stopped is over however long it actually ran', () => {
  assert.equal(elapsedBand(5, HOUR, 'timed_out'), 'over');
  assert.equal(elapsedBand(5, HOUR, 'failed'), 'normal', 'a failure is not a timeout');
  assert.equal(elapsedBand(5, HOUR, 'done'), 'normal');
});

test('the budget is the stage override, then the default, then the hour', () => {
  const budgets = { default_seconds: 1800, per_stage: { seo_review: 900 } };
  assert.equal(stageBudgetSeconds('seo_review', budgets), 900);
  assert.equal(stageBudgetSeconds('write', budgets), 1800, 'no override means the default');
  assert.equal(stageBudgetSeconds('write', {}), DEFAULT_STAGE_BUDGET_SECONDS);
  assert.equal(stageBudgetSeconds('write', undefined), DEFAULT_STAGE_BUDGET_SECONDS);
  assert.equal(stageBudgetSeconds(null, undefined), DEFAULT_STAGE_BUDGET_SECONDS);
  assert.equal(DEFAULT_STAGE_BUDGET_SECONDS, HOUR);
});

test('a nonsense budget never makes every run look over its limit', () => {
  assert.equal(stageBudgetSeconds('write', { default_seconds: 0 }), HOUR);
  assert.equal(stageBudgetSeconds('write', { per_stage: { write: -5 } }), HOUR);
  assert.equal(elapsedBand(10, 0), 'normal');
});

test('the operator copy is the agreed sentence, to the minute', () => {
  assert.equal(
    timedOutSentence(HOUR),
    'Stopped after 60 minutes (the limit for this agent). Any partial output has been saved as a draft.',
  );
  assert.equal(timedOutSentence(900), 'Stopped after 15 minutes (the limit for this agent). Any partial output has been saved as a draft.');
  assert.equal(
    stageBudgetLine(HOUR),
    'Stage budget: 60 minutes - set on the agent, not editable here.',
  );
  assert.equal(
    REVIEW_STALE_BANNER,
    'This draft changed after its last SEO review. Re-run SEO review before publishing.',
  );
  assert.equal(
    REVIEW_STALE_REASON,
    'seo_review must re-run before publish - the draft changed after the last review',
  );
});

test('the stage order is the one the agent and the panel both hardcode', () => {
  assert.deepEqual(
    [...STAGE_ORDER],
    ['research', 'keyword', 'angle', 'outline', 'write', 'seo_review', 'edit', 'assemble', 'image', 'publish', 'done'],
    'both sides of the contract walk this list - a reorder here silently mis-marks downstream stages',
  );
});

test('a retry keeps everything before the stage and regenerates the rest', () => {
  assert.deepEqual(stagesKeptBy('seo_review'), ['research', 'keyword', 'angle', 'outline', 'write']);
  assert.deepEqual(stagesRegeneratedBy('seo_review'), [
    'seo_review',
    'edit',
    'assemble',
    'image',
    'publish',
  ]);
  assert.deepEqual(stagesKeptBy('research'), [], 'the first stage keeps nothing');
  assert.deepEqual(stagesRegeneratedBy('publish'), ['publish']);
  assert.deepEqual(stagesRegeneratedBy('nonsense'), [], 'an unknown stage claims nothing');
  assert.equal(STAGE_ORDER.at(-1), 'done', 'done is a state, never a regenerated stage');
});

const session = (over: Partial<StageSession> & { status: string }): StageSession => ({
  started_at: '2026-09-22T02:00:00.000Z',
  ...over,
});

test('a retry marks its stage and every later one out of date', () => {
  const stale = outOfDateStages({ stale_from_stage: 'write', attempt: 2 }, []);
  assert.equal(stale.has('outline'), false, 'an upstream stage is untouched');
  for (const stage of ['write', 'seo_review', 'edit', 'assemble', 'image', 'publish']) {
    assert.ok(stale.has(stage), `${stage} is downstream of the retry`);
  }
  assert.equal(stale.has('done'), false, 'done is not a stage that regenerates');
});

test('a stage clears the marker once it completes on the current attempt', () => {
  const article = { stale_from_stage: 'write', attempt: 2 };
  const sessions = [
    session({ stage: 'write', attempt: 2, status: 'done' }),
    session({ stage: 'seo_review', attempt: 1, status: 'done' }),
    session({ stage: 'edit', attempt: 2, status: 'running' }),
  ];
  const stale = outOfDateStages(article, sessions);
  assert.equal(stale.has('write'), false, 're-run on this attempt');
  assert.ok(stale.has('seo_review'), 'its only pass was against the draft that was replaced');
  assert.ok(stale.has('edit'), 'still running is not yet regenerated');
});

test('a test run never clears the marker - it writes nothing', () => {
  const stale = outOfDateStages(
    { stale_from_stage: 'seo_review', attempt: 3 },
    [session({ stage: 'seo_review', attempt: 3, status: 'done', kind: 'test' })],
  );
  assert.ok(stale.has('seo_review'));
});

test('nothing is out of date until the agent says a stage was superseded', () => {
  assert.equal(outOfDateStages({}, []).size, 0);
  assert.equal(outOfDateStages({ stale_from_stage: null }, []).size, 0);
  assert.equal(outOfDateStages({ stale_from_stage: 'not_a_stage' }, []).size, 0);
});

test('attempts group per stage, in pipeline order, oldest attempt first', () => {
  const sessions = [
    session({ stage: 'seo_review', attempt: 2, status: 'timed_out' }),
    session({ stage: 'write', attempt: 1, status: 'done' }),
    session({ stage: 'seo_review', attempt: 1, status: 'failed' }),
  ];
  const { groups, ungrouped } = groupAttempts(sessions);
  assert.deepEqual(groups.map((g) => g.stage), ['write', 'seo_review']);
  assert.deepEqual(groups[1].sessions.map((s) => s.attempt), [1, 2]);
  assert.deepEqual(ungrouped, []);
});

test('a stage the panel does not know is still grouped, and sorts last', () => {
  const { groups } = groupAttempts([
    session({ stage: 'quality_gate', status: 'done' }),
    session({ stage: 'write', status: 'done' }),
  ]);
  assert.deepEqual(groups.map((g) => g.stage), ['write', 'quality_gate']);
});

test('a session with no stage is never guessed into a group', () => {
  const scout = session({ status: 'done', stage: null });
  const legacy = session({ status: 'failed' });
  const { groups, ungrouped } = groupAttempts([scout, legacy]);
  assert.deepEqual(groups, []);
  assert.equal(ungrouped.length, 2, 'both stay in the flat list');
});

test('only in-flight work carries a stop, and it is named for its state', () => {
  assert.ok(isStoppable('running'));
  assert.ok(isStoppable('queued'));
  for (const over of ['timed_out', 'failed', 'cancelled', 'done', 'waiting_approval']) {
    assert.equal(isStoppable(over), false, `${over} has nothing left to stop`);
  }
  assert.equal(stopControlLabel('running'), 'Stop run', 'work that started is stopped');
  assert.equal(stopControlLabel('queued'), 'Cancel run', 'work that has not is cancelled');
  assert.equal(stopControlLabel('waiting_approval'), 'Cancel run', 'nothing is in flight to stop');
  assert.match(stopControlHint('running'), /re-run it from the run page/);
  assert.match(stopControlHint('queued'), /^Cancel this queued run/);
});

test('the stop is reported in the tense the agent answered in', () => {
  const asked = stoppedNotice('Best cordless stick vacuums', true);
  assert.match(asked, /^Stopping “Best cordless stick vacuums”/, 'a running stage lets go later');
  assert.match(asked, /kept as a draft/, 'and says what survived it');
  const done = stoppedNotice('Best cordless stick vacuums', false);
  assert.match(done, /^“Best cordless stick vacuums” stopped/, 'a queued run is off the queue now');
  assert.doesNotMatch(done, /Stopping/);
});

/**
 * `agent_sessions` has never had a `stage` column - the agent names the work
 * in `agent`, and derives the stage from it exactly as this map does. Without
 * the derivation the attempt history groups nothing at all against a real
 * agent, which is the whole feature going quietly blank.
 */
test('a session is placed by its reported stage, else by the agent that ran it', () => {
  assert.equal(sessionStage(session({ status: 'done', agent: 'seo_reviewer' })), 'seo_review');
  assert.equal(
    sessionStage(session({ status: 'done', agent: 'writer', stage: 'edit' })),
    'edit',
    'a reported stage always wins over the derivation',
  );
  assert.equal(sessionStage(session({ status: 'done', agent: 'topic_scout' })), null);
  assert.equal(sessionStage(session({ status: 'done', agent: 'quality_gate' })), null);
  assert.equal(sessionStage(session({ status: 'done' })), null);
  for (const stage of STAGE_ORDER.filter((s) => s !== 'done')) {
    assert.ok(
      Object.values(AGENT_STAGE).includes(stage),
      `${stage} has an agent, so a session of it can be placed`,
    );
  }
});

test('attempts group per stage off the payload a real agent sends', () => {
  const { groups, ungrouped } = groupAttempts([
    session({ agent: 'seo_reviewer', attempt: 2, status: 'timed_out' }),
    session({ agent: 'writer', attempt: 1, status: 'done' }),
    session({ agent: 'seo_reviewer', attempt: 1, status: 'failed' }),
    session({ agent: 'topic_scout', attempt: 1, status: 'done' }),
  ]);
  assert.deepEqual(groups.map((g) => g.stage), ['write', 'seo_review']);
  assert.deepEqual(groups[1].sessions.map((s) => s.attempt), [1, 2]);
  assert.equal(ungrouped.length, 1, 'the topic search is still never guessed onto a stage');
});

test('a stage regenerated by a retry clears its marker off the agent name alone', () => {
  const stale = outOfDateStages({ stale_from_stage: 'write', attempt: 2 }, [
    session({ agent: 'writer', attempt: 2, status: 'done' }),
    session({ agent: 'seo_reviewer', attempt: 2, status: 'timed_out' }),
  ]);
  assert.equal(stale.has('write'), false, 're-run on the current attempt');
  assert.ok(stale.has('seo_review'), 'stopped, so never regenerated');
});

test('a test run is read whether it arrives wrapped or on its own', () => {
  const wrapped = readTestStageResult({
    result: { stage: 'seo_review', agent: 'seo_reviewer', cost_usd: '0.1640', session_id: 's1' },
  });
  assert.equal(wrapped?.stage, 'seo_review');
  assert.equal(wrapped?.cost_usd, 0.164);
  assert.equal(wrapped?.session_id, 's1');

  const flat = readTestStageResult({
    stage: 'write',
    agent: 'writer',
    model: 'claude-opus-5',
    output: { draft: 'x' },
    tokensInput: 100,
    tokensOutput: 20,
    costUsd: 0.5,
    sessionId: 's2',
    durationMs: 92_000,
  });
  assert.equal(flat?.stage, 'write');
  assert.equal(flat?.cost_usd, 0.5);
  assert.equal(flat?.tokens_input, 100);
  assert.equal(flat?.session_id, 's2');
  assert.equal(flat?.duration_ms, 92_000);
  assert.deepEqual(flat?.output, { draft: 'x' });
});

test('an answer that names no stage is reported as no result, never as an empty one', () => {
  assert.equal(readTestStageResult(null), null);
  assert.equal(readTestStageResult('nope'), null);
  assert.equal(readTestStageResult({ ok: true }), null);
  assert.equal(readTestStageResult({ result: { output: 'x' } }), null);
});

test('a session on no stage is measured against no budget at all', () => {
  assert.equal(sessionBudgetSeconds(session({ status: 'done', agent: 'topic_scout' })), null);
  assert.equal(sessionBudgetSeconds(session({ status: 'done' })), null);
  assert.equal(
    sessionBudgetSeconds(session({ status: 'done', agent: 'seo_reviewer' }), {
      per_stage: { seo_review: 900 },
    }),
    900,
  );
  assert.equal(
    sessionBudgetSeconds(session({ status: 'done', agent: 'writer' })),
    DEFAULT_STAGE_BUDGET_SECONDS,
  );
});

test('publish is the one stage an isolated test never offers to run', () => {
  for (const stage of STAGE_ORDER.filter((s) => s !== 'publish' && s !== 'done')) {
    assert.ok(isTestableStage(stage), `${stage} runs an agent and writes nothing on its own`);
  }
  assert.equal(isTestableStage('publish'), false, 'writing to the live site is all it does');
  assert.equal(isTestableStage('done'), false, 'and done runs no agent at all');
  assert.match(UNTESTABLE_STAGE_HINT, /cannot be tested on its own/);
});
