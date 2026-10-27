// The corpus query is the only I/O the scanner depends on, and it runs inside
// a review round. So the two things that matter are the SQL it actually sends
// (posts is a live table the website builds from) and that nothing it can hit -
// an unset database, a failed query, a site with no posts yet - is allowed to
// fail the round.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// SleekDrops' content database is DATABASE_URL itself, and these tests never
// open it: every query below is answered by a stand-in for the pool.
process.env.DATABASE_URL = 'postgres://corpus:test@localhost:5/corpus_test';

const { pool } = await import('../db/pool.js');
const { loadPublishedCorpus, DEFAULT_CORPUS_LIMIT } = await import('./corpus.js');
const { detectSlop } = await import('./slop.js');

interface Sent {
  sql: string;
  params: unknown[];
}

/** Stand in for the content store, capturing the query and replying with `rows` - or failing with them. */
function stubStore(rows: unknown[] | Error): { sent: Sent[]; restore: () => void } {
  const original = pool.query;
  const sent: Sent[] = [];
  pool.query = (async (sql: string, params: unknown[] = []) => {
    sent.push({ sql, params });
    if (rows instanceof Error) throw rows;
    return { rows };
  }) as unknown as typeof pool.query;
  return { sent, restore: () => { pool.query = original; } };
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

test('asks the content store for published bodies only, newest first, excluding this article', async () => {
  const stub = stubStore([row('best-air-fryers', 'The Ninja AF160 holds 5.7 litres.')]);
  try {
    const corpus = await loadPublishedCorpus({ excludeSlug: 'best-stick-vacuums' });

    assert.equal(stub.sent.length, 1);
    const [query] = stub.sent;
    assert.match(query.sql, /FROM posts/);
    assert.match(query.sql, /status = 'published'/);
    assert.match(query.sql, /ORDER BY posts\.pub_date DESC/);
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
  const stub = stubStore([]);
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
  const stub = stubStore([row('a', ''), row('b', '   '), row('c', 'Real prose.', null)]);
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
  const stub = stubStore(new Error('relation "posts" does not exist'));
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[corpus\]/);
  } finally {
    stub.restore();
  }
});

test('an unset content database warns and returns an empty corpus, it does not throw', async () => {
  const url = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const stub = stubStore([]);
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.equal(stub.sent.length, 0, 'no query is attempted without a database to send it to');
    assert.match(warnings[0], /scanning this draft in isolation/);
    assert.match(warnings[0], /DATABASE_URL is not set/);
  } finally {
    stub.restore();
    process.env.DATABASE_URL = url;
  }
});

test('the database dying mid-round does not fail the round', async () => {
  const stub = stubStore(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  try {
    const { result, warnings } = await quiet(() => loadPublishedCorpus());
    assert.deepEqual(result, []);
    assert.match(warnings[0], /ECONNRESET/);
  } finally {
    stub.restore();
  }
});

test('what it loads is what detectSlop takes - the reviewer needs no adapter', async () => {
  const opening = `If you want the best portable Bluetooth speaker in Australia right now, buy the
JBL Flip 6. It costs $149 RRP and it is the one we would hand to a friend
without a caveat.

## Why the JBL Flip 6 wins

JBL rates the Flip 6 at 12 hours of playback, and the IP67 rating means a
poolside drop by the pool is survivable and not the end of the speaker.`;
  const stub = stubStore([row('best-portable-bluetooth-speakers', opening)]);
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
