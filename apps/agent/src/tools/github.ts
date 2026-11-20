// Rebuilds a platform's website after the publisher writes its content: a POST to
// the platform's deploy hook when it has one, else a repository dispatch to its
// repo with the platform's own event type (SleekDrops' is `content-updated`), so
// one brand's publish never starts the workflow that deploys another's site.
import { config } from '../config.js';
import type { ResolvedPublishTarget } from '../platform/publishTarget.js';

export type RebuildTarget = Pick<ResolvedPublishTarget, 'githubRepo' | 'rebuildHookUrl' | 'dispatchEventType'>;

/** Both calls are one small POST; a GitHub that has not answered by now is not going to. */
const REBUILD_TIMEOUT_MS = 15_000;
const USER_AGENT = 'sleekdrops-agent';

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export async function dispatchContentUpdated(target: RebuildTarget): Promise<void> {
  if (target.rebuildHookUrl) {
    // The hook URL is itself the credential, so neither message carries it -
    // nor the transport error, whose cause can.
    const res = await fetch(target.rebuildHookUrl, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw new Error(
        isTimeout(err)
          ? `the rebuild hook did not answer within ${REBUILD_TIMEOUT_MS / 1000}s`
          : 'the rebuild hook could not be reached',
      );
    });
    if (!res.ok) throw new Error(`the rebuild hook failed (HTTP ${res.status})`);
    return;
  }
  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN is not set — cannot trigger the site rebuild');
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${target.githubRepo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.github.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ event_type: target.dispatchEventType }),
      signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
    });
    // GitHub returns 204 No Content on success.
    if (res.status !== 204) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`GitHub repository_dispatch failed (HTTP ${res.status}): ${detail}`);
    }
  } catch (err) {
    if (isTimeout(err)) {
      throw new Error(`GitHub repository_dispatch did not answer within ${REBUILD_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}
