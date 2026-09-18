// Bounded retry where it actually lands: a real claimed row, the real
// runStage, and the admin API the board reads the verdict back through.
//
// failures.test.ts proves the taxonomy in isolation. It cannot prove that a
// transient fault costs a retry instead of the card, that the attempt count
// and the class reach the columns, that a genuine failure still produces
// exactly today's failed card, or that each attempt keeps its own session row.
// Those only happen against Postgres. Point DATABASE_URL at a throwaway server
// to run these.
//
// The publish stage is the vehicle: it is deterministic, needs no model, and
// its only outside dependency is `fetch` to Cloudflare D1 - so a fault can be
// injected at the network boundary, which is exactly where a transport fault
// comes from in production, without stubbing any of our own code.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
// Before config.js is read. Publishing needs D1 configured to get as far as
// the fetch we are about to fault; the values are never sent anywhere,
// because every fetch in this file is answered locally.
process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-token';
process.env.GITHUB_TOKEN = 'test-token';
// A Claude credential would turn the genuine-failure case below into a live
// model call from a test suite that must never make one.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { getSetting, pool, q } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { runStage } = await import('./runner.js');
const { MAX_STAGE_ATTEMPTS, stageRetryDelayMs } = await import('./failures.js');
const { createApp } = await import('../api/server.js');

import type { ArticleRow } from './types.js';

/**
 * The two columns migration 012 adds. Declared here rather than on ArticleRow:
 * pipeline/types.ts belongs to the card widening the evidence gate, and the
 * runner writes these through updateArticle(), which takes column names.
 */
type FailureColumns = { failure_class: string | null; stage_attempts: number };

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/** The admin panel can store a Claude token too; if one is there, stand down. */
const credentialled =
  reachable && (await getSetting<{ claude_token?: string }>('llm', {})).claude_token;
const modelSkip = credentialled
  ? 'the database carries a Claude token - this test must not reach a live model'
  : skip;

const app = createApp();
const AUTH = { Authorization: 'Bearer test-admin-token' };
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  if (reachable) await pool.end();
});

/** A D1 reply that means "written". */
const d1Ok = (): Response =>
  new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Answer every outbound request from the test, never the network. `answer`
 * sees the D1 calls only; the site-rebuild dispatch that follows a successful
 * publish is accepted as GitHub would accept it.
 */
function stubFetch(answer: (call: number) => Response | never): number[] {
  const calls: number[] = [];
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0]);
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
    assert.match(url, /api\.cloudflare\.com/, 'the publish stage talks to D1 and GitHub, nothing else');
    calls.push(calls.length + 1);
    return answer(calls.length);
  }) as typeof fetch;
  return calls;
}

async function insertPublishable(fields: Record<string, unknown> = {}): Promise<ArticleRow> {
  const slug = `best-stick-vacuums-${randomUUID().slice(0, 8)}`;
  const row = {
    title: 'Best cordless stick vacuums',
    category: 'Home',
    post_type: 'guide',
    stage: 'publish',
    status: 'running',
    claimed_by: 'test-worker',
    claimed_at: new Date(),
    slug,
    draft_md: '# Best cordless stick vacuums\n\nA body.',
    frontmatter: JSON.stringify({ title: 'Best cordless stick vacuums', author: 'desk' }),
    ...fields,
  };
  const keys = Object.keys(row);
  const [inserted] = await q<ArticleRow>(
    `INSERT INTO articles (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return inserted;
}

const reload = async (id: string): Promise<ArticleRow & FailureColumns> =>
  (await q<ArticleRow & FailureColumns>('SELECT * FROM articles WHERE id = $1', [id]))[0];

const sessionsFor = async (id: string) =>
  q<{ status: string; summary: string | null; error: string | null }>(
    'SELECT status, summary, error FROM agent_sessions WHERE article_id = $1 ORDER BY started_at ASC',
    [id],
  );

test('a transient fault costs a retry, not the card', { skip }, async () => {
  const article = await insertPublishable();
  // A dropped connection on the first attempt, a working D1 on the second.
  stubFetch((call) => {
    if (call === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    return d1Ok();
  });
  const waits: number[] = [];

  await runStage(article, { sleep: async (ms) => void waits.push(ms) });

  const done = await reload(article.id);
  assert.equal(done.status, 'done', 'the article finished the stage it would have died on');
  assert.equal(done.stage, 'done');
  assert.equal(done.error, null);
  assert.equal(done.failure_class, null, 'a recovered card carries no failure class');
  assert.equal(done.stage_attempts, 2, 'the attempt it took is on the card');
  assert.ok(done.published_at, 'the stage actually did its work on the retry');
  assert.deepEqual(waits, [stageRetryDelayMs(1)], 'one backoff, before the second attempt');

  const sessions = await sessionsFor(article.id);
  assert.deepEqual(
    sessions.map((s) => s.status),
    ['failed', 'done'],
    'the failed attempt keeps its own session row rather than being overwritten',
  );
  assert.match(sessions[0].summary ?? '', /attempt 1 of 3/);
  assert.match(sessions[0].error ?? '', /fetch failed/);
});

test('a transient fault that never clears fails the card, bounded and labelled', { skip }, async () => {
  const article = await insertPublishable();
  const calls = stubFetch(() => {
    throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
  });
  const waits: number[] = [];

  await runStage(article, { sleep: async (ms) => void waits.push(ms) });

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'publish', 'a failed stage must not advance the article');
  assert.equal(failed.failure_class, 'transient');
  assert.equal(failed.stage_attempts, MAX_STAGE_ATTEMPTS);
  assert.match(failed.error ?? '', /fetch failed/, 'the message still reaches the card verbatim');
  assert.equal(failed.claimed_by ?? null, null, 'the claim is released so a retry can pick it up');
  assert.equal(calls.length, MAX_STAGE_ATTEMPTS, 'three attempts, not an unbounded loop');
  assert.deepEqual(waits, [stageRetryDelayMs(1), stageRetryDelayMs(2)], 'the backoff doubles');

  const sessions = await sessionsFor(article.id);
  assert.equal(sessions.length, MAX_STAGE_ATTEMPTS);
  assert.deepEqual(
    sessions.map((s) => s.status),
    ['failed', 'failed', 'failed'],
  );
  assert.equal(sessions[2].summary, 'publish failed', 'the last one reads as it always has');

  // What the board shows for that card.
  const res = await app.fetch(new Request('http://localhost/api/articles', { headers: AUTH }));
  const { articles } = (await res.json()) as { articles: Array<Record<string, unknown>> };
  const seen = articles.find((a) => a.id === article.id)!;
  assert.equal(seen.failure_class, 'transient');
  assert.equal(seen.stage_attempts, MAX_STAGE_ATTEMPTS);
});

test('a genuine failure fails the card on the first attempt, message intact', { skip }, async () => {
  const article = await insertPublishable();
  // D1 answering 400 is the API rejecting what we sent, not a wobble.
  const calls = stubFetch(
    () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'no such table: posts' }] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const waits: number[] = [];

  await runStage(article, { sleep: async (ms) => void waits.push(ms) });

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_class, 'genuine');
  assert.equal(failed.stage_attempts, 1);
  assert.match(failed.error ?? '', /no such table: posts/);
  assert.equal(calls.length, 1, 'a genuine failure is not retried');
  assert.deepEqual(waits, [], 'and nothing is waited out');

  const sessions = await sessionsFor(article.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'failed');
  assert.equal(sessions[0].summary, 'publish failed');
  assert.equal(sessions[0].error, failed.error);
});

test('a stage that cannot start is still terminal, and says which kind', { skip: modelSkip }, async () => {
  // The other route to a failed card: the model pick throws before there is a
  // session to fail. The engine defaults to Claude and this process has no
  // credential, so the writer stage cannot start - and a missing credential is
  // nobody's hiccup. Driven off the default rather than off a `models`
  // override, because that setting is global and other suites run beside this
  // one against the same database.
  const article = await insertPublishable({ stage: 'write', slug: null, draft_md: null });

  await runStage(article);

  const failed = await reload(article.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_class, 'genuine');
  assert.equal(failed.stage_attempts, 1);
  assert.match(failed.error ?? '', /writer is set to run on claude/);
  assert.match(failed.error ?? '', /not configured/);

  const [session] = await sessionsFor(article.id);
  assert.equal(session.status, 'failed');
  assert.equal(session.error, failed.error, 'the message on the card is the message on the session');
});

test('the operator retry clears the last verdict off the card', { skip }, async () => {
  const article = await insertPublishable({
    status: 'failed',
    error: 'publish failed',
    failure_class: 'transient',
    stage_attempts: 3,
  });

  const res = await app.fetch(
    new Request(`http://localhost/api/articles/${article.id}/retry`, {
      method: 'POST',
      headers: AUTH,
    }),
  );
  assert.equal(res.status, 200);

  const requeued = await reload(article.id);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.error, null);
  assert.equal(requeued.failure_class, null);
  assert.equal(requeued.stage_attempts, 0);
});

test('a card mid-backoff reads as busy, not stranded', { skip }, async () => {
  const article = await insertPublishable();
  stubFetch(() => {
    throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
  });
  const claim = async () =>
    (
      await q<{ stage_attempts: number; failure_class: string | null; claimed_at: Date }>(
        'SELECT stage_attempts, failure_class, claimed_at FROM articles WHERE id = $1',
        [article.id],
      )
    )[0];
  const during: Array<Awaited<ReturnType<typeof claim>>> = [];

  await runStage(article, { sleep: async () => void during.push(await claim()) });

  const started = (await claim()).claimed_at;
  assert.deepEqual(
    during.map((row) => row.stage_attempts),
    [1, 2],
    'the count is on the card while it waits, not only once it is over',
  );
  assert.equal(during[0].failure_class, 'transient');
  assert.ok(
    during[1].claimed_at > during[0].claimed_at,
    'each retry renews the lease, so recoverStranded cannot hand the card to a second worker',
  );
  assert.equal(started, null, 'and the claim is released once the card finally fails');
});

test('a card cancelled mid-backoff is left alone', { skip }, async () => {
  const article = await insertPublishable();
  stubFetch(() => {
    throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
  });

  await runStage(article, {
    sleep: async () => {
      await q("UPDATE articles SET status = 'cancelled', updated_at = now() WHERE id = $1", [
        article.id,
      ]);
    },
  });

  const cancelled = await reload(article.id);
  assert.equal(cancelled.status, 'cancelled', 'the retry must not resurrect a cancelled card');
  assert.equal(cancelled.stage_attempts, 1);
});
