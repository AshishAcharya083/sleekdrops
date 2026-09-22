// The ceiling is the half of the guard configuration cannot reach: a
// deployment can ask for any budget it likes, and the code decides what it
// gets. Its own file because the value is read once, when config.js loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A day, as a deployment might set it after one long stage scared someone.
process.env.AGENT_RUN_TIMEOUT_SECONDS = '86400';

const { config, MAX_STAGE_TIMEOUT_SECONDS } = await import('../config.js');
const { stageBudgetSeconds } = await import('./stageTimeout.js');

test('configuration can ask for more than the ceiling and still not get it', () => {
  assert.equal(config.agentRunTimeoutSeconds, 86400, 'what the deployment asked for');
  assert.equal(stageBudgetSeconds(), MAX_STAGE_TIMEOUT_SECONDS, 'what the stage gets');
  assert.equal(stageBudgetSeconds(86400 * 2), MAX_STAGE_TIMEOUT_SECONDS, 'nor can an override');
});
