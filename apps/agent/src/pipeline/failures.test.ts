// The taxonomy's whole value is in what it refuses to call transient. A wrong
// 'transient' burns three stage runs and still fails the card; a wrong
// 'genuine' only costs what every failure costs today. These tests hold that
// asymmetry in place, and they name real errors - the ones the pipeline
// actually throws or actually receives - rather than invented ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGateError } from '../content/evidence.js';
import { classifyFailure, MAX_STAGE_ATTEMPTS, stageRetryDelayMs } from './failures.js';
import { extractJson, requireKeys } from '../llm/index.js';

const classOf = (err: unknown): string => classifyFailure(err).failureClass;

test('the parse failure that killed a card is transient', () => {
  // The reported one, verbatim: the outliner's reply had balanced braces but
  // malformed content, so JSON.parse threw from inside extractJson.
  const err = new SyntaxError(
    "Expected ',' or ']' after array element in JSON at position 2546 (line 61 column 7)",
  );
  assert.equal(classOf(err), 'transient');
  assert.equal(classifyFailure(err).signal, 'parse');
});

test("extractJson's own two refusals are transient", () => {
  const truncated = (): unknown => {
    try {
      extractJson('{"summary":"cut off here');
    } catch (err) {
      return err;
    }
  };
  const noJson = (): unknown => {
    try {
      extractJson('I could not complete that request.');
    } catch (err) {
      return err;
    }
  };
  assert.equal(classOf(truncated()), 'transient');
  assert.equal(classOf(noJson()), 'transient');
});

test('a shape complaint is transient - the model can be asked again', () => {
  const complaint = requireKeys<{ facts: unknown; products: unknown }>('facts', 'products')({
    facts: [],
  });
  assert.equal(classOf(new Error(String(complaint))), 'transient');
  assert.equal(classOf(new Error('Expected a JSON object, got an array — return the whole object')), 'transient');
});

test('timeouts, socket faults and throttled providers are transient', () => {
  for (const message of [
    'Tavily HTTP 429: rate limit exceeded',
    'D1 query failed (HTTP 503): {"errors":[]}',
    'HTTP 502 fetching www.choice.com.au',
    'The operation was aborted',
    'Claude engine returned an empty completion',
  ]) {
    assert.equal(classOf(new Error(message)), 'transient', message);
  }

  const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.equal(classOf(socket), 'transient');

  // What `fetch` actually throws: the reason is only on the cause.
  const fetchFailed = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
  });
  assert.equal(classOf(fetchFailed), 'transient');
});

test('an engine that hangs or falls over is transient', () => {
  // The deadline messages claude.ts and gemini.ts actually throw. Neither says
  // "timeout" or "aborted", so they only classify correctly if the engine
  // signature names them - and a hung engine is the most retryable fault the
  // pipeline has, well inside the stage budget that would otherwise catch it.
  for (const message of [
    'Claude engine did not answer within 10 minutes',
    'Gemini engine did not answer within 10 minutes',
    'Claude engine failed (error_during_execution)',
    'Claude engine hit its 30-turn budget before answering',
    'Claude engine ended without a result message',
  ]) {
    const verdict = classifyFailure(new Error(message));
    assert.equal(verdict.failureClass, 'transient', message);
    assert.equal(verdict.signal, 'engine', message);
  }
});

test('the evidence gate is genuine - another gather reaches the same count', () => {
  const gate = new EvidenceGateError({
    pass: false,
    postType: 'guide',
    message: 'Evidence is too thin to write a guide from: dated price observations 0/3.',
    shortfalls: [],
    counts: {},
    checkedAt: new Date().toISOString(),
  });
  assert.equal(classOf(gate), 'genuine');
  assert.equal(classifyFailure(gate).signal, null);
});

test('content and contract failures are genuine, and so is anything unrecognised', () => {
  for (const message of [
    'no affiliate links for a transactional piece: the dossier carried 3 product(s), the draft ' +
      'linked 3 /go/ slug(s), and healing recovered 0 of 3. There is nothing on the page for a ' +
      'reader to click.',
    'the dossier has no products and a discovery pass for "best stick vacuum" found none either',
    'the post\'s frontmatter is not valid JSON — refusing to overwrite it',
    'researcher is set to run on claude-opus-5. No Claude credential is configured',
    'TAVILY_API_KEY is not set — add it to apps/agent/.env',
    'Cloudflare D1 env missing — need CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_TOKEN',
    'something nobody has seen before',
  ]) {
    assert.equal(classOf(new Error(message)), 'genuine', message);
  }
});

test('a thrown non-Error is genuine rather than a crash', () => {
  assert.equal(classOf('just a string'), 'genuine');
  assert.equal(classOf(undefined), 'genuine');
});

test('the retry is bounded and backs off', () => {
  assert.equal(MAX_STAGE_ATTEMPTS, 3, 'at most two retries, per the runner contract');
  assert.deepEqual(
    [1, 2].map(stageRetryDelayMs),
    [2_000, 4_000],
    'each wait doubles, so a throttled provider gets time to clear',
  );
});
