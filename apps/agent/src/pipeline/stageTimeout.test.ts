// The budget a stage gets, and the sentence an operator reads when it runs out.
//
// The scrubbing case is the one with teeth: the strings that end up in
// agent_sessions.error are written by an SDK about the child process it just
// ran, and that child's environment is where the Claude subscription token
// lives. A token that reaches the column is a token in every backup, every
// panel screenshot and every log sink downstream of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Before config.js reads it: this file asserts the default budget.
delete process.env.AGENT_RUN_TIMEOUT_SECONDS;

const { DEFAULT_STAGE_TIMEOUT_SECONDS } = await import('../config.js');
const { MAX_STAGE_TIMEOUT_SECONDS, STAGE_TIMEOUT_SECONDS } = await import('./budgets.js');
const { formatBudget, scrubSecrets, stageBudgetSeconds, stageTimeoutError, stageTimeoutMessage } =
  await import('./stageTimeout.js');

import type { StageTimeoutDetail } from './types.js';

const detail = (overrides: Partial<StageTimeoutDetail> = {}): StageTimeoutDetail => ({
  agent: 'seo_reviewer',
  stage: 'seo_review',
  budgetSeconds: 3600,
  elapsedSeconds: 3601,
  lastCall: 'claude-opus-5 with web search, retry 1 of 2, in flight for 41m 12s',
  timeoutCause: 'budget',
  ...overrides,
});

/** Run `body` with a per-stage override in place, however it ends. */
function withOverride(seconds: number, body: () => void): void {
  STAGE_TIMEOUT_SECONDS.seo_review = seconds;
  try {
    body();
  } finally {
    delete STAGE_TIMEOUT_SECONDS.seo_review;
  }
}

test('a stage with no override runs on the configured budget', () => {
  assert.equal(stageBudgetSeconds('seo_review'), DEFAULT_STAGE_TIMEOUT_SECONDS);
  assert.equal(stageBudgetSeconds('done'), DEFAULT_STAGE_TIMEOUT_SECONDS);
});

test('a per-stage override wins, but never past the ceiling', () => {
  withOverride(900, () => {
    assert.equal(stageBudgetSeconds('seo_review'), 900);
    assert.equal(stageBudgetSeconds('write'), DEFAULT_STAGE_TIMEOUT_SECONDS, 'and only for it');
  });
  withOverride(MAX_STAGE_TIMEOUT_SECONDS * 10, () => {
    assert.equal(stageBudgetSeconds('seo_review'), MAX_STAGE_TIMEOUT_SECONDS);
  });
});

test('a nonsense override falls back rather than disabling the guard', () => {
  for (const override of [0, -60, Number.NaN, Number.POSITIVE_INFINITY]) {
    withOverride(override, () => {
      assert.equal(stageBudgetSeconds('seo_review'), DEFAULT_STAGE_TIMEOUT_SECONDS);
    });
  }
});

test('a limit is stated the way an operator states it', () => {
  assert.equal(formatBudget(3600), '60 minutes');
  assert.equal(formatBudget(60), '1 minute');
  assert.equal(formatBudget(90), '90 seconds');
});

test('the message names the agent, stage, limit, elapsed time and last call', () => {
  const message = stageTimeoutMessage(detail(), {});
  assert.match(message, /seo_reviewer/);
  assert.match(message, /seo_review stage/);
  assert.match(message, /60 minutes/);
  assert.match(message, /1h 0m/);
  assert.match(message, /Last LLM call attempted: claude-opus-5 with web search/);
  assert.match(message, /saved as a draft/);
});

test('a reaped run says it stopped reporting, not that it spent its budget', () => {
  const message = stageTimeoutMessage(detail({ timeoutCause: 'lease', lastCall: null }), {});
  assert.match(message, /stopped reporting progress/);
  assert.match(message, /reaped/);
  assert.match(
    message,
    /did not report what it was waiting on/,
    'a reaping worker cannot see what the dead one was doing, and says so',
  );
});

test('a Claude OAuth token planted in an SDK error never reaches the message', () => {
  const token = `sk-ant-oat01-${'Ab3'.repeat(20)}`;
  const env = { CLAUDE_CODE_OAUTH_TOKEN: token, PATH: '/usr/bin:/bin' };
  const sdkError =
    'Claude Code process exited with code 1\n' +
    `  spawn env: {"CLAUDE_CODE_OAUTH_TOKEN":"${token}","PATH":"/usr/bin:/bin"}\n` +
    `  at query (/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:1:1) [token=${token}]`;

  const error = stageTimeoutError(detail({ lastCall: sdkError }), env);

  assert.equal(error.message.includes(token), false);
  assert.match(error.message, /\[redacted CLAUDE_CODE_OAUTH_TOKEN\]/);
  // Still readable: the redaction replaces the value, not the diagnosis.
  assert.match(error.message, /Claude Code process exited with code 1/);
  assert.equal(error.agent, 'seo_reviewer');
  assert.equal(error.stage, 'seo_review');
  assert.equal(error.budgetSeconds, 3600);
  assert.equal(error.timeoutCause, 'budget');
});

test('a credential shape is redacted even when this process never held it', () => {
  // The admin panel can store a Claude token that only ever reaches the child.
  const adminToken = `sk-ant-oat01-${'Zz9'.repeat(15)}`;
  const scrubbed = scrubSecrets(`spawn failed with ${adminToken}`, {});
  assert.equal(scrubbed.includes(adminToken), false);
  assert.match(scrubbed, /\[redacted Anthropic credential\]/);
});

test('every secret-shaped env value is redacted, whatever the provider', () => {
  const env = {
    TAVILY_API_KEY: 'tvly-0123456789abcdef',
    DATABASE_URL: 'postgres://sleekdrops:hunter2hunter2@db:5432/agent',
    GITHUB_TOKEN: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
  };
  const scrubbed = scrubSecrets(
    `search failed for ${env.TAVILY_API_KEY}, pool ${env.DATABASE_URL}, dispatch ${env.GITHUB_TOKEN}`,
    env,
  );
  for (const value of Object.values(env)) assert.equal(scrubbed.includes(value), false);
});

test('ordinary text survives: a short password is not a reason to redact a word', () => {
  const scrubbed = scrubSecrets('the app could not reach the app database', {
    PGPASSWORD: 'app',
    HOME: '/home/agent',
  });
  assert.equal(scrubbed, 'the app could not reach the app database');
});
