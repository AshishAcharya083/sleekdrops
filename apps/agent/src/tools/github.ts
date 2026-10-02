// Rebuilds a platform's website after the publisher writes to D1: a POST to
// the platform's deploy hook when it has one, else the `content-updated`
// repository dispatch to its repo (same contract the old pipeline used).
import { config } from '../config.js';
import type { ResolvedPublishTarget } from '../platform/publishTarget.js';

export type RebuildTarget = Pick<ResolvedPublishTarget, 'githubRepo' | 'rebuildHookUrl'>;

export async function dispatchContentUpdated(target: RebuildTarget): Promise<void> {
  if (target.rebuildHookUrl) {
    // The hook URL is itself the credential, so neither message carries it -
    // nor the transport error, whose cause can.
    const res = await fetch(target.rebuildHookUrl, {
      method: 'POST',
      headers: { 'User-Agent': 'sleekdrops-agent' },
    }).catch(() => {
      throw new Error('the rebuild hook could not be reached');
    });
    if (!res.ok) throw new Error(`the rebuild hook failed (HTTP ${res.status})`);
    return;
  }
  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN is not set — cannot trigger the site rebuild');
  }
  const res = await fetch(`https://api.github.com/repos/${target.githubRepo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'sleekdrops-agent',
    },
    body: JSON.stringify({ event_type: 'content-updated' }),
  });
  // GitHub returns 204 No Content on success.
  if (res.status !== 204) {
    throw new Error(`repository_dispatch failed (HTTP ${res.status}): ${await res.text()}`);
  }
}
