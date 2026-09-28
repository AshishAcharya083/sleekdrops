// The parts of the queue that are pure: the retry policy, and what a payload
// says before any network sees it. The database side is queue.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unreachable';
process.env.SITE_URL = 'https://sleekdrops.com';

const {
  describeEnqueue,
  MAX_POST_ATTEMPTS,
  RETRY_BASE_SECONDS,
  RETRY_CAP_SECONDS,
  articleUrl,
  renderPayload,
  retriesExhausted,
  retryDelaySeconds,
  taggedUrl,
} = await import('./queue.js');
const { credentialEnvName, isChannelTokenRef, tokenStaleness, TOKEN_STALE_WINDOW_MS } = await import(
  './channels.js'
);

import type { DistributableArticle } from './types.js';

function article(fields: Partial<DistributableArticle> = {}): DistributableArticle {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'quiet-commutes',
    title: 'The headphones for a quiet commute',
    frontmatter: {
      title: 'The headphones for a quiet commute',
      dek: 'Four weeks on the 7:12, ranked.',
      heroImage: 'https://storage.googleapis.com/images/heroes/quiet-commutes.png',
    },
    hero_image_url: null,
    hero_image_source: 'generated',
    ...fields,
  };
}

// ── Retry policy ───────────────────────────────────────────────────────────

test('the backoff doubles per spent attempt and then stops growing', () => {
  assert.equal(retryDelaySeconds(1), RETRY_BASE_SECONDS);
  assert.equal(retryDelaySeconds(2), RETRY_BASE_SECONDS * 2);
  assert.equal(retryDelaySeconds(3), RETRY_BASE_SECONDS * 4);
  assert.equal(retryDelaySeconds(4), RETRY_BASE_SECONDS * 8);
  assert.equal(retryDelaySeconds(40), RETRY_CAP_SECONDS, 'a long-dead network must not overflow');
  // Defensive: a row read back with a nonsense attempt count still waits.
  assert.equal(retryDelaySeconds(0), RETRY_BASE_SECONDS);
  assert.equal(retryDelaySeconds(-3), RETRY_BASE_SECONDS);
});

test('retries are bounded, so a queue item cannot spin forever', () => {
  assert.equal(retriesExhausted(MAX_POST_ATTEMPTS - 1), false);
  assert.equal(retriesExhausted(MAX_POST_ATTEMPTS), true);
  assert.equal(retriesExhausted(MAX_POST_ATTEMPTS + 1), true);
});

// ── The rendered payload ───────────────────────────────────────────────────

test('the destination is tagged per network and per placement', () => {
  const url = new URL(taggedUrl('quiet-commutes', 'facebook', 'first_comment'));
  assert.equal(url.origin + url.pathname, 'https://sleekdrops.com/blog/quiet-commutes');
  assert.equal(url.searchParams.get('utm_source'), 'facebook');
  assert.equal(url.searchParams.get('utm_medium'), 'social');
  assert.equal(url.searchParams.get('utm_content'), 'first_comment');
  // The placement is in the tag because the failure it has to expose - a
  // comment link a network rendered as unclickable text - is invisible from
  // the API side and only shows up as referrals that never arrive.
  assert.equal(
    new URL(taggedUrl('quiet-commutes', 'facebook', 'in_body')).searchParams.get('utm_content'),
    'in_body',
  );
  assert.equal(articleUrl('quiet-commutes'), 'https://sleekdrops.com/blog/quiet-commutes');
});

test('a hero we generated may be uploaded; one we found may not', () => {
  const generated = renderPayload(article(), 'facebook', 'first_comment');
  assert.equal(
    generated.imageUrl,
    'https://storage.googleapis.com/images/heroes/quiet-commutes.png',
  );
  assert.equal(generated.imageSource, 'generated');

  for (const source of ['found', 'operator'] as const) {
    const payload = renderPayload(article({ hero_image_source: source }), 'facebook', 'in_body');
    assert.equal(payload.imageUrl, null, `a ${source} hero is not ours to sublicense`);
    assert.equal(payload.imageSource, source, 'the provenance still travels, so a ladder can act');
  }
});

test('an article with no hero at all reports no provenance', () => {
  const payload = renderPayload(
    article({ frontmatter: { title: 'No hero here' }, hero_image_source: 'generated' }),
    'facebook',
    'first_comment',
  );
  assert.equal(payload.imageUrl, null);
  assert.equal(payload.imageSource, null);
  assert.equal(payload.expected.ogImage, null, 'nothing to wait for on the live page');
});

test('the link is in the caption only when the placement asks for it', () => {
  const inBody = renderPayload(article(), 'facebook', 'in_body');
  assert.ok(inBody.caption.includes(inBody.url), 'in_body carries the link in the post');

  const firstComment = renderPayload(article(), 'facebook', 'first_comment');
  assert.ok(!firstComment.caption.includes('https://'), 'first_comment keeps the caption clean');
  assert.equal(firstComment.commentText, firstComment.url);
  assert.ok(firstComment.caption.startsWith('The headphones for a quiet commute'));
});

test('the readiness expectation is the live page contract, not the caption', () => {
  const payload = renderPayload(article(), 'facebook', 'first_comment');
  assert.equal(payload.expected.ogTitle, 'The headphones for a quiet commute');
  assert.equal(
    payload.expected.ogImage,
    'https://storage.googleapis.com/images/heroes/quiet-commutes.png',
  );
});

test('an enqueue explains itself in one line for the session log', () => {
  assert.equal(
    describeEnqueue({ created: 0, alreadyQueued: 0, skipped: 'draft' }),
    'not distributed (draft)',
  );
  assert.equal(
    describeEnqueue({ created: 0, alreadyQueued: 0, skipped: 'no-channels' }),
    'no channels connected',
  );
  assert.equal(describeEnqueue({ created: 2, alreadyQueued: 0, skipped: null }), 'queued for 2 channel(s)');
  assert.equal(
    describeEnqueue({ created: 0, alreadyQueued: 2, skipped: null }),
    'queued for 0 channel(s), 2 already queued',
  );
});

// ── Token staleness ────────────────────────────────────────────────────────

test('token staleness is derived once, for the worker and the panel both', () => {
  const now = new Date('2026-09-23T00:00:00Z');
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

  assert.deepEqual(tokenStaleness(null, now), {
    expiresAt: null,
    expired: false,
    stale: false,
    hoursRemaining: null,
  });

  const healthy = tokenStaleness(inDays(30), now);
  assert.equal(healthy.expired, false);
  assert.equal(healthy.stale, false);
  assert.equal(healthy.hoursRemaining, 720);

  const soon = tokenStaleness(inDays(TOKEN_STALE_WINDOW_MS / 86_400_000 - 1), now);
  assert.equal(soon.expired, false);
  assert.equal(soon.stale, true, 'an operator needs warning before the token lapses, not after');

  const gone = tokenStaleness(inDays(-1), now);
  assert.equal(gone.expired, true);
  assert.equal(gone.stale, true);
  assert.equal(gone.hoursRemaining, -24);

  // A column nothing could parse is treated as unusable: refusing to post is
  // the half of that mistake an operator can undo.
  assert.equal(tokenStaleness('not a timestamp', now).expired, true);
});

test('a secret reference names an env var without carrying a value', () => {
  assert.equal(credentialEnvName('facebook-page-token'), 'FACEBOOK_PAGE_TOKEN');
  assert.equal(credentialEnvName('bluesky.app.password'), 'BLUESKY_APP_PASSWORD');
  assert.equal(credentialEnvName('  threads token  '), 'THREADS_TOKEN');
});

test("a channel's secret name can only name a channel secret", () => {
  assert.equal(isChannelTokenRef('facebook-page-token', 'facebook'), true);
  assert.equal(isChannelTokenRef('FACEBOOK_PAGE_TOKEN', 'facebook'), true);
  assert.equal(isChannelTokenRef('channel-sleekdrops-page', 'facebook'), true);
  // The agent's own configuration, even under the network's prefix.
  assert.equal(isChannelTokenRef('facebook-app-secret', 'facebook'), false);
  assert.equal(isChannelTokenRef('FACEBOOK_GRAPH_VERSION', 'facebook'), false);
  for (const platform of ['ADMIN_TOKEN', 'database-url', 'ANTHROPIC_API_KEY', 'github-token']) {
    assert.equal(isChannelTokenRef(platform, 'facebook'), false, platform);
  }
  assert.equal(isChannelTokenRef('facebook', 'facebook'), false, 'a bare prefix names nothing');
  assert.equal(isChannelTokenRef('bluesky-app-password', 'facebook'), false, "another network's secret");
});
