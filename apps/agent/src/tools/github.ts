// Fires the `content-updated` repository dispatch that rebuilds the website
// after the publisher writes to D1 (same contract the old pipeline used).
import { config } from '../config.js';

export async function dispatchContentUpdated(): Promise<void> {
  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN is not set — cannot trigger the site rebuild');
  }
  const res = await fetch(`https://api.github.com/repos/${config.github.repo}/dispatches`, {
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
