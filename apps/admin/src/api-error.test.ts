import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  apiErrorFromResponse,
  describeApiError,
  failureKindForStatus,
  toApiError,
} from './api-error.ts';

const TRACE_HEADER = 'X-Trace-Id';
const TRACE_ID = '0199b3e7c2f97c9aa4b1d2e3f4a5b6c7';

test('the bearer-auth rejection is classified as an auth problem, not an outage', () => {
  assert.equal(failureKindForStatus(401), 'unauthorized');
  assert.equal(failureKindForStatus(403), 'unauthorized');
});

test('a server fault and a refused request are told apart', () => {
  assert.equal(failureKindForStatus(500), 'server');
  assert.equal(failureKindForStatus(503), 'server');
  assert.equal(failureKindForStatus(400), 'request');
  assert.equal(failureKindForStatus(404), 'request');
});

test('a 401 prompts for the admin token instead of blaming the network', async () => {
  // Exactly what the agent's bearer-auth middleware answers with, echoed trace
  // id and all (see apps/agent/src/api/server.test.ts).
  const res = new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', [TRACE_HEADER]: TRACE_ID },
  });
  const error = apiErrorFromResponse(res, await res.json(), TRACE_HEADER);

  assert.equal(error.kind, 'unauthorized');
  const message = describeApiError(error);
  assert.match(message, /admin token/i);
  assert.doesNotMatch(message, /unreachable/i);
});

test('a 5xx says the server errored and carries the trace id to the agent logs', async () => {
  // The agent's onError envelope: a generic message plus the trace id that
  // names its log lines.
  const res = new Response(JSON.stringify({ error: 'internal server error', traceId: TRACE_ID }), {
    status: 500,
    headers: { 'Content-Type': 'application/json', [TRACE_HEADER]: TRACE_ID },
  });
  const error = apiErrorFromResponse(res, await res.json(), TRACE_HEADER);

  assert.equal(error.kind, 'server');
  const message = describeApiError(error);
  assert.match(message, /server errored/i);
  assert.match(message, new RegExp(TRACE_ID));
  assert.doesNotMatch(message, /unreachable/i);
});

test('a failure with no body still picks the trace id off the echoed header', async () => {
  const res = new Response('<html>502</html>', {
    status: 502,
    headers: { [TRACE_HEADER]: TRACE_ID },
  });
  const error = apiErrorFromResponse(res, {}, TRACE_HEADER);

  assert.equal(error.message, 'HTTP 502');
  assert.equal(error.traceId, TRACE_ID);
  assert.match(describeApiError(error), new RegExp(TRACE_ID));
});

test('a 5xx without a trace id still points at the agent logs', () => {
  const message = describeApiError(new ApiError('HTTP 502', { kind: 'server', status: 502 }));
  assert.match(message, /agent logs/i);
});

test('only a request that never got an answer reads as unreachable', () => {
  const message = describeApiError(new ApiError('Failed to fetch', { kind: 'unreachable' }));
  assert.match(message, /unreachable/i);
  assert.match(message, /Failed to fetch/);
});

test('a refused request shows what the agent refused it for', () => {
  const error = new ApiError('title is required', { kind: failureKindForStatus(400), status: 400 });
  assert.match(describeApiError(error), /title is required/);
});

test('anything else a caller catches still becomes a describable failure', () => {
  const wrapped = toApiError(new TypeError('Failed to fetch'));
  assert.equal(wrapped.kind, 'unreachable');
  assert.equal(wrapped.message, 'Failed to fetch');
  assert.match(describeApiError(wrapped), /unreachable/i);

  assert.equal(toApiError('boom').message, 'boom');
});

test('an ApiError passes through normalisation unchanged, keeping its kind', () => {
  const original = new ApiError('unauthorized', { kind: 'unauthorized', status: 401 });
  assert.equal(toApiError(original), original);
});
