/** Source-level contract for the deliberately simple topic-search queue UI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const topics = read('./pages/Topics.tsx');
const api = read('./api.ts');
const events = read('./analytics.ts');

test('the Topics tab polls a queue summary rather than a worker lock', () => {
  assert.match(topics, /usePoll<ScoutQueueStatus>\('\/api\/scout\/queue'\)/);
  assert.match(api, /export interface ScoutQueueStatus \{/);
  assert.doesNotMatch(topics, /scout\/lock|clear(?:ing)?Lock|Clear lock|lease/i);
  assert.doesNotMatch(api, /ScoutLock|heartbeat_age_seconds/);
});

test('starting discovery always presents the request as queued', () => {
  assert.match(topics, /api\('\/api\/scout', \{ method: 'POST' \}\)/);
  assert.match(topics, /Topic search added to the queue\./);
  assert.match(topics, /refreshQueue\(\)/, 'actions refresh queue depth as well as topics');
  assert.match(topics, /EVENTS\.scoutRunQueued/);
  assert.match(events, /scoutRunQueued: 'Scout Run Queued'/);
  assert.doesNotMatch(events, /Scout Lock Cleared/);
});

test('queue progress is human-readable and contains no implementation details', () => {
  assert.match(topics, /Topic discovery is/);
  assert.match(topics, /searching now/);
  assert.match(topics, /searches'\} queued/);
  assert.doesNotMatch(topics, /run <code>|heartbeat|refused/);
});
