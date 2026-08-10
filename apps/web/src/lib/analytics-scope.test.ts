/**
 * Unit tests for the document-scoped state itself - the guards `./analytics`
 * composes, checked here against a plain host object, without a DOM and without
 * the SDK.
 *
 * That composition is exercised end to end in analytics.test.ts, which imports
 * the shipped analytics module twice and drives the real DevTeam SDK through it;
 * these are the narrower statements about what each helper promises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyticsScope,
  bufferEvent,
  claimOnce,
  drainBuffer,
  dropBuffer,
  ensureClient,
  type ScopeHost,
} from './analytics-scope.ts';

/** A stand-in client: these tests care only about how many of them exist. */
interface FakeClient {
  id: number;
}

test('one host means one state object, whichever module copy asks for it', () => {
  const document: ScopeHost = {};
  const fromChrome = analyticsScope<FakeClient>(document);
  const fromBanner = analyticsScope<FakeClient>(document);

  assert.equal(fromChrome, fromBanner);
  assert.notEqual(fromChrome, analyticsScope<FakeClient>({}), 'a new document is a new state');
  assert.equal(fromChrome.client, null);
  assert.equal(fromChrome.decision, 'unknown');
});

test('a second entry point asking for a client is handed the first one', () => {
  const scope = analyticsScope<FakeClient>({});
  let created = 0;
  const create = (): FakeClient => ({ id: ++created });

  assert.equal(ensureClient(scope, create), ensureClient(scope, create));
  assert.equal(created, 1, 'a second client would be a second $session_start');
  assert.equal(scope.client?.id, 1);
});

test('a key can be claimed once per document, and each key on its own', () => {
  const scope = analyticsScope<FakeClient>({});

  assert.equal(claimOnce(scope, 'Page Viewed|/'), true);
  assert.equal(claimOnce(scope, 'Page Viewed|/'), false);
  // A genuine same-document navigation is a different key, so it still counts.
  assert.equal(claimOnce(scope, 'Page Viewed|/deals/foo'), true);
});

test('draining the buffer empties it, so no flush can send the same event twice', () => {
  const scope = analyticsScope<FakeClient>({});
  const first = { event: 'Page Viewed', props: { event_id: 'a' } };
  bufferEvent(scope, first);
  bufferEvent(scope, { event: 'Hero CTA Clicked', props: { event_id: 'b' } });

  const drained = drainBuffer(scope);
  assert.equal(drained.length, 2);
  assert.equal(drained[0], first, 'an event must come back exactly as it went in');
  assert.deepEqual(drainBuffer(scope), []);

  bufferEvent(scope, first);
  dropBuffer(scope);
  assert.deepEqual(drainBuffer(scope), []);
});
