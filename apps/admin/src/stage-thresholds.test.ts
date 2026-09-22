/**
 * The threshold scale, the stage bookkeeping and the fixed operator copy.
 *
 * Both sides of the platform apply the same two boundaries - the agent stops a
 * run at its budget, the panel decides which runs are listed as stuck and how
 * a cell is coloured - so a disagreement here is a run that is listed as stuck
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
  isLeaseLapsed,
  isRetryableRun,
  isStoppable,
  isTestableStage,
  outOfDateStages,
  readTestStageResult,
  retryBlockedReason,
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
  stoppedSession,
  STAGE_AGENT,
  stuckRuns,
  timedOutSentence,
  untestableStageHint,
  type StageSession,
  type StuckArticle,
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

/**
 * The control is badged "wrote nothing" and says the article's stored output is
 * untouched, so the set it is offered on has to be exactly the stages that
 * honour it. `image` is the trap: it runs an agent like any other stage, but it
 * uploads over the article's own fixed hero object key, so a test of it
 * replaces the picture a published article is already serving.
 */
test('a stage a test run would write over is never offered as a test', () => {
  const untestable = ['image', 'publish', 'done'];
  for (const stage of STAGE_ORDER.filter((s) => !untestable.includes(s))) {
    assert.ok(isTestableStage(stage), `${stage} runs an agent and writes nothing on its own`);
  }
  assert.equal(isTestableStage('image'), false, 'it overwrites the hero the article already serves');
  assert.equal(isTestableStage('publish'), false, 'writing to the live site is all it does');
  assert.equal(isTestableStage('done'), false, 'and done runs no agent at all');
  for (const stage of untestable) {
    assert.match(untestableStageHint(stage), /cannot be tested on its own|nothing to test/i);
  }
  assert.match(untestableStageHint('image'), /hero image/i, 'and it says which write it would make');
});

/**
 * The Overview surface, derived off the two payloads the tab holds. The agent
 * reports no stuck section of its own, so this derivation is the surface: if
 * it answers nothing, a wedged run is invisible on the landing screen, which
 * is the exact failure this feature exists to end.
 */
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const article = (over: Partial<StuckArticle> & { status: string }): StuckArticle => ({
  id: 'a1',
  title: 'Best cordless stick vacuums',
  stage: 'seo_review',
  ...over,
});

test('a run past the soft bound of its stage budget is surfaced, one inside it is not', () => {
  const list = [
    article({ id: 'slow', status: 'running', claimed_at: ago(31), lease_expires_at: ago(-4) }),
    article({ id: 'fine', status: 'running', claimed_at: ago(20), lease_expires_at: ago(-4) }),
  ];
  const runs = stuckRuns(list, [], null, NOW);
  assert.deepEqual(runs.map((r) => r.article_id), ['slow'], 'only the one past half its hour');
  assert.equal(Math.round(runs[0].elapsed_seconds ?? 0), 31 * 60, 'measured from the claim');
  assert.equal(runs[0].budget_seconds, HOUR);
  assert.equal(runs[0].agent, 'seo_reviewer', 'named by the agent its stage runs under');
  assert.equal(runs[0].lease_expired, false);
});

test('a run the budget already stopped is always surfaced, however long ago', () => {
  const runs = stuckRuns(
    [article({ id: 'stopped', status: 'timed_out', stage: 'write', updated_at: ago(600) })],
    [
      {
        id: 's1',
        article_id: 'stopped',
        agent: 'writer',
        status: 'timed_out',
        started_at: ago(660),
        ended_at: ago(600),
      },
    ],
    null,
    NOW,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].session_id, 's1', 'linked at the session that recorded it');
  assert.equal(Math.round(runs[0].elapsed_seconds ?? 0), 60 * 60, 'off the session that ran it');
  assert.equal(runs[0].agent, 'writer');
});

test('a stopped run whose session has aged off the list reports when it stopped', () => {
  // The reaper clears the lease columns as it stops the run, so nothing on the
  // article says when it started. An invented duration would be the one number
  // on this surface that measured nothing - the stop time it does leave behind
  // is what the row says instead.
  const [run] = stuckRuns([article({ status: 'timed_out', updated_at: ago(5) })], [], null, NOW);
  assert.equal(run.elapsed_seconds, null);
  assert.equal(run.stopped_at, ago(5), 'off the article row, which outlives every session list');
  assert.equal(run.budget_seconds, HOUR, 'the budget it was stopped by is still known');
});

test('a stopped run reports the moment its own session recorded, when it has one', () => {
  const [run] = stuckRuns(
    [article({ status: 'timed_out', stage: 'write', updated_at: ago(58) })],
    [
      {
        id: 's1',
        article_id: 'a1',
        agent: 'writer',
        status: 'timed_out',
        started_at: ago(120),
        ended_at: ago(60),
      },
    ],
    null,
    NOW,
  );
  assert.equal(Math.round(run.elapsed_seconds ?? 0), 60 * 60);
  assert.equal(run.stopped_at, ago(60), 'the session end, not the row\'s last write');
});

test('a live run is never given a stop time it has not reached', () => {
  const [run] = stuckRuns(
    [article({ status: 'running', claimed_at: ago(40), lease_expires_at: ago(-4), updated_at: ago(40) })],
    [],
    null,
    NOW,
  );
  assert.equal(run.stopped_at, null);
});

test('a claim whose lease has lapsed is surfaced before it is past any bound', () => {
  const [run] = stuckRuns(
    [article({ status: 'running', claimed_at: ago(6), lease_expires_at: ago(1) })],
    [],
    null,
    NOW,
  );
  assert.equal(run.lease_expired, true, 'nothing is renewing it - it is wedged, not slow');
  assert.equal(elapsedBand(run.elapsed_seconds ?? 0, run.budget_seconds), 'normal');
});

test('a healthy pipeline produces an empty surface, not a hidden one', () => {
  const list = [
    article({ id: 'queued', status: 'queued' }),
    article({ id: 'done', status: 'done', stage: 'done' }),
    article({ id: 'failed', status: 'failed' }),
    article({ id: 'live', status: 'running', claimed_at: ago(4), lease_expires_at: ago(-4) }),
  ];
  assert.deepEqual(stuckRuns(list, [], null, NOW), []);
});

test('the surface reads the budgets the agent reported, not a built-in hour', () => {
  const budgets = { default_seconds: 600, per_stage: { seo_review: 1200 } };
  const [run] = stuckRuns(
    [article({ status: 'running', claimed_at: ago(11), lease_expires_at: ago(-4) })],
    [],
    budgets,
    NOW,
  );
  assert.equal(run.budget_seconds, 1200, 'the stage override, not the default');
  const onDefault = stuckRuns(
    [article({ status: 'running', stage: 'write', claimed_at: ago(6), lease_expires_at: ago(-4) })],
    [],
    budgets,
    NOW,
  );
  assert.equal(onDefault[0].budget_seconds, 600);
});

test('an isolated test run never describes the state of the article', () => {
  const [run] = stuckRuns(
    [article({ status: 'timed_out' })],
    [
      { id: 't1', article_id: 'a1', agent: 'seo_reviewer', kind: 'test', status: 'timed_out', started_at: ago(90), ended_at: ago(30) },
    ],
    null,
    NOW,
  );
  assert.equal(run.session_id, null, 'a test wrote nothing and stopped nothing');
  assert.equal(run.elapsed_seconds, null);
});

test('an isolated test run never speaks for the run the budget stopped', () => {
  // The same rule the triage surface follows, on the one payload the run
  // detail quotes: a test that hit the budget wrote nothing, so the stop card,
  // the stage it names and the scrubbed detail under it must not be its story.
  const testRun: StageSession & { id: string } = {
    id: 't1',
    agent: 'seo_reviewer',
    kind: 'test',
    status: 'timed_out',
    started_at: '2026-09-22T09:00:00.000Z',
  };
  const pipelineRun: StageSession & { id: string } = {
    id: 'p1',
    agent: 'writer',
    status: 'timed_out',
    started_at: '2026-09-22T08:00:00.000Z',
  };
  assert.equal(stoppedSession([pipelineRun, testRun])?.id, 'p1', 'the run that moved the article');
  assert.equal(stoppedSession([testRun]), null, 'and nothing at all when only a test stopped');
  assert.equal(
    sessionStage(stoppedSession([pipelineRun, testRun]) as StageSession),
    'write',
    'so the stage the stop card names is the one the pipeline was on',
  );
});

test('the stopped session is the last one the budget stopped, not the last of any kind', () => {
  const sessions: Array<StageSession & { id: string }> = [
    { id: 'a', agent: 'writer', status: 'timed_out', started_at: '2026-09-22T08:00:00.000Z' },
    { id: 'b', agent: 'writer', status: 'timed_out', started_at: '2026-09-22T09:00:00.000Z' },
    { id: 'c', agent: 'seo_reviewer', status: 'done', started_at: '2026-09-22T10:00:00.000Z' },
  ];
  assert.equal(stoppedSession(sessions)?.id, 'b');
  assert.equal(stoppedSession([]), null);
});

test('every stage names the agent that runs it, both ways round', () => {
  for (const [agent, stage] of Object.entries(AGENT_STAGE)) {
    assert.equal(STAGE_AGENT[stage], agent);
  }
});

test('a stage the run has passed is no longer out of date, even if it never ran', () => {
  // `edit` runs only when seo_review fails. A retry from write whose new draft
  // passes review first time skips it - and the marker has to clear anyway, or
  // a live, published article carries "Out of date" for ever.
  const stale = outOfDateStages({ stale_from_stage: 'write', stage: 'done', attempt: 2 }, [
    session({ agent: 'writer', attempt: 2, status: 'done' }),
    session({ agent: 'seo_reviewer', attempt: 2, status: 'done' }),
    session({ agent: 'assembler', attempt: 2, status: 'done' }),
    session({ agent: 'image_agent', attempt: 2, status: 'done' }),
    session({ agent: 'publisher', attempt: 2, status: 'done' }),
  ]);
  assert.equal(stale.size, 0, 'nothing on a published article is labelled stale');
});

test('the marker still holds on everything the run has not reached again', () => {
  const stale = outOfDateStages({ stale_from_stage: 'write', stage: 'assemble', attempt: 2 }, []);
  assert.equal(stale.has('write'), false, 'the run is past it');
  assert.equal(stale.has('edit'), false, 'skipped, and behind the run');
  for (const stage of ['assemble', 'image', 'publish']) {
    assert.ok(stale.has(stage), `${stage} has not been regenerated yet`);
  }
});

test('a retry is only offered where the agent would accept one', () => {
  // Exactly the statuses pipeline/retry.ts re-queues from, plus the running
  // article whose claim has lapsed - which it also takes, and which is the
  // stalled run this whole surface exists to recover.
  for (const status of ['failed', 'timed_out', 'cancelled', 'waiting_approval']) {
    assert.equal(isRetryableRun(status), true, `${status} is retryable`);
  }
  assert.equal(isRetryableRun('running'), false, 'a live claim is refused mid-stage');
  assert.equal(isRetryableRun('running', true), true, 'a lapsed claim is not');
  assert.equal(isRetryableRun('queued'), false, 'a run that has not started has nothing to re-run');
  assert.equal(isRetryableRun('done'), false, 'and a published one is not retried, it is re-run');
});

test('a run that cannot be retried says why, in something the operator can do', () => {
  assert.match(retryBlockedReason('running'), /Stop the run first/);
  assert.match(retryBlockedReason('queued'), /queued and has not started/);
  assert.match(retryBlockedReason('done'), /Run the whole pipeline again/);
});

test('a claim with no lease reported is treated as live, not as lapsed', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  // The agent's own guard reads a null lease as "nobody holds this".
  assert.equal(isLeaseLapsed(null, now), true);
  assert.equal(isLeaseLapsed('2026-09-22T11:59:00Z', now), true);
  assert.equal(isLeaseLapsed('2026-09-22T12:01:00Z', now), false);
  // An agent that reports no lease column at all says nothing about the claim,
  // and the panel must not read silence as permission to re-queue it.
  assert.equal(isLeaseLapsed(undefined, now), false);
});
