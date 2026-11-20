// The site rebuild after a publish. A deploy hook or GitHub that never answers
// must fail the publish step with a message naming the call and its limit,
// rather than wedge it - and the hook's message must not carry the hook URL,
// which is itself the credential.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_TOKEN = 'test-github-token';
const { dispatchContentUpdated } = await import('./github.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fail every call the way fetch does once its AbortSignal.timeout fires, keeping the signal it was given. */
function timeOutEveryCall(): { signals: Array<AbortSignal | null | undefined> } {
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init?.signal);
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;
  return { signals };
}

const HOOK_URL = 'https://hooks.example/secret-hook-token';

test('a rebuild hook that never answers fails with its time limit and without its URL', async () => {
  const { signals } = timeOutEveryCall();

  await assert.rejects(
    dispatchContentUpdated({
      githubRepo: 'example/site',
      rebuildHookUrl: HOOK_URL,
      dispatchEventType: 'example-content-updated',
    }),
    { message: 'the rebuild hook did not answer within 15s' },
  );
  assert.ok(signals[0] instanceof AbortSignal);
});

test('a repository dispatch GitHub never answers fails with its time limit', async () => {
  const { signals } = timeOutEveryCall();

  await assert.rejects(
    dispatchContentUpdated({
      githubRepo: 'example/site',
      rebuildHookUrl: null,
      dispatchEventType: 'example-content-updated',
    }),
    { message: 'GitHub repository_dispatch did not answer within 15s' },
  );
  assert.ok(signals[0] instanceof AbortSignal);
});
