// The worker loop against a stub provider and a stub site: the readiness gate,
// the retry policy, and what a failure is allowed to write down.
//
// No network is involved. The provider is a stub registered under a name
// unique to each test, so a claim here can never take a concurrent suite's
// work, and the page fetcher is injected.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SITE_URL = 'https://sleekdrops.com';

const { pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { getSetting, setSetting } = await import('../db/pool.js');
const { claimNextItem, enqueuePublishedArticle, getItem, retryDelaySeconds, MAX_POST_ATTEMPTS } =
  await import('./queue.js');
const { registerProvider, registeredProviders, unregisterProvider } = await import('./providers.js');
const { distributionTick, processItem } = await import('./worker.js');
const { READINESS_RETRY_SECONDS, READINESS_WINDOW_SECONDS } = await import('./readiness.js');
const { PermanentProviderError } = await import('./types.js');

import type { DistributableArticle, DistributionItem, PostReceipt, SocialProvider } from './types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const TOKEN = 'stub-access-token-9f3c1a';
const TOKEN_REF = 'stub-worker-token';
process.env.STUB_WORKER_TOKEN = TOKEN;

const articles: string[] = [];
const connections: string[] = [];
const registered: string[] = [];

after(async () => {
  for (const name of registered) unregisterProvider(name);
  if (reachable) {
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

const TITLE = 'The headphones for a quiet commute';
const HERO = 'https://storage.googleapis.com/images/heroes/quiet.png';

/** The page a finished rebuild serves, as apps/web's SEOHead renders it. */
const livePage = {
  status: 200,
  body: `<meta property="og:title" content="${TITLE} | SleekDrops" />
         <meta property="og:image" content="${HERO}" />`,
};
/** What the same URL serves while the rebuild is still running. */
const notBuiltYet = { status: 404, body: '<html>Not found</html>' };

/** A provider that does whatever the test needs and records what it was given. */
function stub(
  post: (item: DistributionItem, accessToken: string) => Promise<PostReceipt>,
): SocialProvider & { name: string } {
  const name = `stub-worker-${randomUUID().slice(0, 8)}`;
  const provider: SocialProvider = {
    name,
    authenticate: async () => {
      throw new Error('not used here');
    },
    refreshToken: async () => {
      throw new Error('not used here');
    },
    post: async ({ item, accessToken }) => post(item, accessToken),
    fetchInsights: async () => ({
      impressions: 0,
      clicks: 0,
      reactions: 0,
      fetchedAt: new Date().toISOString(),
    }),
  };
  registerProvider(provider);
  registered.push(name);
  return provider as SocialProvider & { name: string };
}

async function connect(provider: string, tokenRef = TOKEN_REF): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, $3) RETURNING id`,
    [provider, `page-${randomUUID().slice(0, 8)}`, tokenRef],
  );
  connections.push(row.id);
  return row.id;
}

async function article(): Promise<DistributableArticle> {
  const frontmatter = { title: TITLE, dek: 'Four weeks on the 7:12, ranked.', heroImage: HERO };
  const [row] = await q<{ id: string; slug: string }>(
    `INSERT INTO articles (title, slug, category, post_type, stage, status, frontmatter,
                           hero_image_source)
     VALUES ($1, $2, 'Tech', 'guide', 'publish', 'queued', $3::jsonb, 'generated')
     RETURNING id, slug`,
    [TITLE, `quiet-commutes-${randomUUID().slice(0, 8)}`, JSON.stringify(frontmatter)],
  );
  articles.push(row.id);
  return {
    id: row.id,
    slug: row.slug,
    title: TITLE,
    frontmatter,
    hero_image_url: null,
    hero_image_source: 'generated',
  };
}

/** Queue one article for one stub channel and claim it, as a tick would. */
async function queued(provider: string): Promise<DistributionItem> {
  await connect(provider);
  await enqueuePublishedArticle(await article(), { d1Status: 'published' });
  const item = await claimNextItem([provider]);
  assert.ok(item, 'the item was queued and due');
  return item;
}

/** Make a released item due again, and take it back. */
async function reclaim(item: DistributionItem, provider: string): Promise<DistributionItem> {
  await q('UPDATE distribution_queue SET scheduled_at = now() WHERE id = $1', [item.id]);
  const again = await claimNextItem([provider]);
  assert.ok(again, 'the item came back to the queue');
  return again;
}

const secondsFromNow = (at: string): number => (new Date(at).getTime() - Date.now()) / 1000;

// ── The readiness gate ─────────────────────────────────────────────────────

test('nothing is posted until the rebuild serves the piece', { skip }, async () => {
  const provider = stub(async () => {
    throw new Error('the provider must not be reached while the site is still building');
  });
  const item = await queued(provider.name);

  const outcome = await processItem(item, { fetchPage: async () => notBuiltYet });
  assert.equal(outcome, 'waiting');

  const held = (await getItem(item.id))!;
  assert.equal(held.status, 'pending');
  assert.equal(held.attempts, 0, 'a closed gate is not a spent attempt');
  assert.match(held.lastError!, /waiting for the site: HTTP 404/);
  assert.ok(
    Math.abs(secondsFromNow(held.scheduledAt) - READINESS_RETRY_SECONDS) < 5,
    'it comes back in seconds, because a rebuild takes about ninety of them',
  );
});

test('the gate opens as soon as the page is the right page', { skip }, async () => {
  let attempts = 0;
  const provider = stub(async (item) => {
    attempts += 1;
    assert.equal(item.payload.expected.ogTitle, TITLE);
    return { remotePostId: 'remote-42' };
  });
  const item = await queued(provider.name);

  assert.equal(await processItem(item, { fetchPage: async () => notBuiltYet }), 'waiting');
  const second = await reclaim(item, provider.name);
  assert.equal(await processItem(second, { fetchPage: async () => livePage }), 'posted');

  assert.equal(attempts, 1);
  const posted = (await getItem(item.id))!;
  assert.equal(posted.status, 'posted');
  assert.equal(posted.remotePostId, 'remote-42');
  assert.equal(posted.attempts, 1);
  assert.ok(posted.postedAt);
});

test('an item whose page never appears fails instead of waiting forever', { skip }, async () => {
  const provider = stub(async () => {
    throw new Error('unreachable');
  });
  const item = await queued(provider.name);
  const stillBuilding = { fetchPage: async () => notBuiltYet };

  // The clock starts on the first check, so the first pass always waits.
  assert.equal(await processItem(item, stillBuilding), 'waiting');

  const late = new Date(Date.now() + (READINESS_WINDOW_SECONDS + 1) * 1000);
  const second = await reclaim(item, provider.name);
  assert.equal(await processItem(second, { ...stillBuilding, now: () => late }), 'failed');

  const abandoned = (await getItem(item.id))!;
  assert.equal(abandoned.status, 'failed', 'terminal - a rebuild that never came is not a retry');
  assert.equal(abandoned.attempts, 0);
  assert.match(
    abandoned.lastError!,
    new RegExp(`readiness gate never opened within ${READINESS_WINDOW_SECONDS}s: HTTP 404`),
  );
});

test('a page serving the wrong article is not ready either', { skip }, async () => {
  const provider = stub(async () => ({ remotePostId: 'never' }));
  const item = await queued(provider.name);

  const outcome = await processItem(item, {
    fetchPage: async () => ({
      status: 200,
      body: '<meta property="og:title" content="Something else entirely | SleekDrops" />',
    }),
  });
  assert.equal(outcome, 'waiting');
  assert.match((await getItem(item.id))!.lastError!, /og:title is still "Something else entirely/);
});

// ── The retry policy ───────────────────────────────────────────────────────

test('a failed post backs off exponentially and then gives up', { skip }, async () => {
  let calls = 0;
  const provider = stub(async () => {
    calls += 1;
    throw new Error('HTTP 503 from the network');
  });
  let item = await queued(provider.name);

  for (let attempt = 1; attempt < MAX_POST_ATTEMPTS; attempt++) {
    assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'retry');
    const row = (await getItem(item.id))!;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, attempt);
    assert.ok(
      Math.abs(secondsFromNow(row.scheduledAt) - retryDelaySeconds(attempt)) < 5,
      `attempt ${attempt} waits ${retryDelaySeconds(attempt)}s before the next one`,
    );
    item = await reclaim(item, provider.name);
  }

  assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'failed');
  const exhausted = (await getItem(item.id))!;
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.attempts, MAX_POST_ATTEMPTS);
  assert.equal(calls, MAX_POST_ATTEMPTS, 'bounded: the network is called five times, not forever');
  assert.match(exhausted.lastError!, /HTTP 503 from the network \(5 attempt\(s\), giving up\)/);
});

test('an error the network calls permanent is not retried at all', { skip }, async () => {
  const provider = stub(async () => {
    throw new PermanentProviderError('the access token has been revoked');
  });
  const item = await queued(provider.name);

  assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'failed');
  const failed = (await getItem(item.id))!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1, 'four more backoffs would only delay telling an operator');
  assert.equal(failed.lastError, 'the access token has been revoked');
});

test('a credential never reaches last_error', { skip }, async () => {
  const provider = stub(async (_item, accessToken) => {
    // Exactly the shape of a real client that echoes the request it made.
    throw new Error(`POST /me/feed failed: access_token=${accessToken} was rejected`);
  });
  const item = await queued(provider.name);

  await processItem(item, { fetchPage: async () => livePage });
  const failed = (await getItem(item.id))!;
  assert.ok(!failed.lastError!.includes(TOKEN), 'the token must not be written to a column admin reads');
  assert.match(failed.lastError!, /redacted/);
});

test('a token that lives only in settings is redacted too', { skip }, async () => {
  // The scrub built for stage errors knows the environment. A channel token
  // pasted into the admin panel is in no environment variable, so the queue
  // redacts the value it just resolved as well - this is the case that would
  // otherwise leak.
  const ref = `settings-leak-${randomUUID().slice(0, 8)}`;
  const secret = 'pasted-page-credential-4b71';
  const provider = stub(async (_item, accessToken) => {
    throw new Error(`rejected credential ${accessToken}`);
  });
  await connect(provider.name, ref);
  await enqueuePublishedArticle(await article(), { d1Status: 'published' });

  const current = await getSetting<Record<string, string>>('channel_credentials', {});
  await setSetting('channel_credentials', { ...current, [ref]: secret });
  try {
    const item = (await claimNextItem([provider.name]))!;
    await processItem(item, { fetchPage: async () => livePage });
    const failed = (await getItem(item.id))!;
    assert.ok(!failed.lastError!.includes(secret));
    assert.match(failed.lastError!, /rejected credential \[redacted\]/);
  } finally {
    await setSetting('channel_credentials', current);
  }
});

test('a degraded post is recorded as posted, and says what was reduced', { skip }, async () => {
  // The first-comment write is a second call that can fail on its own. An
  // adapter that recovers by appending the link to the caption has still
  // posted, so the item is not a retry - but the panel has to be told.
  const provider = stub(async (_item, accessToken) => ({
    remotePostId: 'remote-degraded',
    degraded: true,
    // Exactly the shape of an adapter that echoes the failed call it recovered
    // from: the note lands in the same column last_error does.
    note: `comment write rejected (access_token=${accessToken}); link appended to the caption`,
  }));
  const item = await queued(provider.name);

  assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'posted');
  const posted = (await getItem(item.id))!;
  assert.equal(posted.status, 'posted');
  assert.equal(posted.remotePostId, 'remote-degraded');
  assert.ok(!posted.lastError!.includes(TOKEN), 'a note is scrubbed like an error is');
  assert.match(posted.lastError!, /link appended to the caption/);
});

test('a degraded post with no note still says so', { skip }, async () => {
  const provider = stub(async () => ({ remotePostId: 'remote-bare', degraded: true }));
  const item = await queued(provider.name);

  assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'posted');
  const posted = (await getItem(item.id))!;
  assert.ok(posted.lastError, 'the signal must not be lost because a provider left the note empty');
});

// ── Credentials ────────────────────────────────────────────────────────────

test('a channel whose secret is configured nowhere stops asking', { skip }, async () => {
  const provider = stub(async () => ({ remotePostId: 'never' }));
  const connection = await connect(provider.name, 'a-secret-nobody-set');
  await enqueuePublishedArticle(await article(), { d1Status: 'published' });
  const item = (await claimNextItem([provider.name]))!;

  assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'blocked');
  const [row] = await q<{ status: string }>('SELECT status FROM channel_connections WHERE id = $1', [
    connection,
  ]);
  assert.equal(row.status, 'needs_reauth', 'it leaves the rotation until an operator acts');

  const held = (await getItem(item.id))!;
  assert.equal(held.attempts, 0, 'our own misconfiguration is not the network failing');
  assert.match(held.lastError!, /no credential found for a-secret-nobody-set/);
});

test('a token pasted into settings wins over the environment', { skip }, async () => {
  const ref = `settings-token-${randomUUID().slice(0, 8)}`;
  const seen: string[] = [];
  const provider = stub(async (_item, accessToken) => {
    seen.push(accessToken);
    return { remotePostId: 'remote-settings' };
  });
  await connect(provider.name, ref);
  await enqueuePublishedArticle(await article(), { d1Status: 'published' });

  const current = await getSetting<Record<string, string>>('channel_credentials', {});
  await setSetting('channel_credentials', { ...current, [ref]: 'rotated-token-value' });
  try {
    const item = (await claimNextItem([provider.name]))!;
    assert.equal(await processItem(item, { fetchPage: async () => livePage }), 'posted');
    assert.deepEqual(seen, ['rotated-token-value']);
  } finally {
    await setSetting('channel_credentials', current);
  }
});

// ── The loop itself ────────────────────────────────────────────────────────

test('one tick claims, gates and posts without any argument but the registry', { skip }, async () => {
  const posted: string[] = [];
  const provider = stub(async (item) => {
    posted.push(item.slug);
    return { remotePostId: `remote-${item.slug}` };
  });
  await connect(provider.name);
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });

  assert.ok(registeredProviders().includes(provider.name), 'the loop finds its adapters here');
  const outcomes = await distributionTick({
    fetchPage: async () => livePage,
    // Scoped to this test's own adapter: the real tick asks the registry, and
    // every suite in this file shares one database.
    availableProviders: () => [provider.name],
  });

  assert.deepEqual(outcomes, ['posted']);
  assert.deepEqual(posted, [piece.slug]);
  assert.deepEqual(
    await distributionTick({
      fetchPage: async () => livePage,
      availableProviders: () => [provider.name],
    }),
    [],
    'and a second tick has nothing left to do',
  );
});

test('a tick with no adapters installed does nothing at all', { skip }, async () => {
  assert.deepEqual(await distributionTick({ availableProviders: () => [] }), []);
});
