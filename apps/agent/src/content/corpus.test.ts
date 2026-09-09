// The corpus query is the only I/O the scanner depends on, and it runs inside
// a review round. So the two things that matter are the SQL it actually sends
// (D1 is a live table the website builds from) and that nothing it can hit -
// missing credentials, a 500, a site with no posts yet - is allowed to fail
// the round.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
process.env.D1_DATABASE_ID = 'test-database';
process.env.CLOUDFLARE_D1_TOKEN = 'test-token';

const { config } = await import('../config.js');
const { loadPublishedCorpus, DEFAULT_CORPUS_LIMIT } = await import('./corpus.js');
const { detectSlop } = await import('./slop.js');

interface Sent {
  url: string;
  sql: string;
  params: unknown[];
}

/** Stand in for D1, capturing the query and replying with `rows`. */
function stubD1(rows: unknown[], ok = true): { sent: Sent[]; restore: () => void } {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { sql: string; params: unknown[] };
    sent.push({ url: String(url), sql: body.sql, params: body.params });
    return new Response(JSON.stringify(ok ? { success: true, result: [{ results: rows }] } : { success: false, errors: ['nope'] }), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

/** Run `fn` with console.warn captured rather than printed. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const row = (slug: string, body: string, pubDate: string | null = '2026-03-01') => ({
  slug,
  title: slug.replace(/-/g, ' '),
  body_md: body,
  pub_date: pubDate,
});

test('asks D1 for published bodies only, newest first, excluding this article', async () => {
  const stub = stubD1([row('best-air-fryers', 'The Ninja AF160 holds 5.7 litres.')]);
  try {
    const corpus = await loadPublishedCorpus({ excludeSlug: 'best-stick-vacuums' });

    assert.equal(stub.sent.length, 1);
    const [query] = stub.sent;
    assert.match(query.sql, /FROM posts/);
    assert.match(query.sql, /status = 'published'/);
    assert.match(query.sql, /ORDER BY pub_date DESC/);
    assert.deepEqual(query.params, ['best-stick-vacuums', DEFAULT_CORPUS_LIMIT]);
    assert.deepEqual(corpus, [
      {
        slug: 'best-air-fryers',
        title: 'best air fryers',
        body: 'The Ninja AF160 holds 5.7 litres.',
        publishedAt: '2026-03-01',
      },
    ]);
  } finally {
    stub.restore();
  }
});

test('takes a bare limit as well as an options object, and caps it', async () => {
  const stub = stubD1([]);
  try {
    await loadPublishedCorpus(5);
    assert.deepEqual(stub.sent[0].params, ['', 5]);

    await loadPublishedCorpus({ limit: 10_000 });
    assert.deepEqual(stub.sent[1].params, ['', 100]);

    await loadPublishedCorpus();
    assert.deepEqual(stub.sent[2].params, ['', DEFAULT_CORPUS_LIMIT]);
  } finally {
    stub.restore();
  }
});

test('drops rows with no body rather than handing the scanner an empty document', async () => {
  const stub = stubD1([row('a', ''), row('b', '   '), row('c', 'Real prose.', null)]);
  try {
    const corpus = await loadPublishedCorpus();
    assert.deepEqual(
      corpus.map((d) => d.slug),
      ['c'],
    );
    assert.equal(corpus[0].publishedAt, null);
  } finally {
    stub.restore();
  }
});

test('a failed query warns once and returns an empty corpus', async () => {
  const stub = stubD1([], false);
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[corpus\]/);
  } finally {
    stub.restore();
  }
});

test('missing D1 credentials warn and return an empty corpus, they do not throw', async () => {
  const accountId = config.d1.accountId;
  config.d1.accountId = '';
  const stub = stubD1([]);
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.equal(stub.sent.length, 0, 'no request is attempted without credentials');
    assert.match(warnings[0], /scanning this draft in isolation/);
  } finally {
    stub.restore();
    config.d1.accountId = accountId;
  }
});

test('the network dying mid-round does not fail the round', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as typeof fetch;
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.match(warnings[0], /ECONNRESET/);
  } finally {
    globalThis.fetch = original;
  }
});

test('what it loads is what detectSlop takes - the reviewer needs no adapter', async () => {
  const opening = `If you want the best portable Bluetooth speaker in Australia right now, buy the
JBL Flip 6. It costs $149 RRP and it is the one we would hand to a friend
without a caveat.

## Why the JBL Flip 6 wins

JBL rates the Flip 6 at 12 hours of playback, and the IP67 rating means a
poolside drop by the pool is survivable and not the end of the speaker.`;
  const stub = stubD1([row('best-portable-bluetooth-speakers', opening)]);
  try {
    const corpus = await loadPublishedCorpus({ excludeSlug: 'best-stick-vacuums' });
    const draft = opening.replace(/Bluetooth speaker/g, 'stick vacuum').replace(/JBL Flip 6/g, 'Dyson V15');

    const report = detectSlop(draft, { corpus });
    assert.ok(
      report.findings.some((f) => f.category === 'repetition'),
      'a rewrite of a published article is caught through the real load path',
    );
    assert.ok(report.score < detectSlop(draft).score);
  } finally {
    stub.restore();
  }
});
