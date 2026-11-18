import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSourceFromEnv, fetchPublishedPosts, FETCH_TIMEOUT_MS } from './fetch-published-posts.ts';

const SOURCE = { supabaseUrl: 'https://peakodds.supabase.co', publishableKey: 'sb_publishable_test' };

/** A fetch that answers each call from `pages` in turn and records what it was asked. */
function fakeSupabase(pages: unknown[][]) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: new URL(String(input)), init });
    const page = pages[requests.length - 1];
    assert.ok(page, `unexpected request ${requests.length}`);
    return new Response(JSON.stringify(page), { status: 200 });
  };
  return { fetch, requests };
}

test('published posts are read a page at a time until a short page', async () => {
  const supabase = fakeSupabase([[{ slug: 'a' }, { slug: 'b' }], [{ slug: 'c' }, { slug: 'd' }], [{ slug: 'e' }]]);

  const rows = await fetchPublishedPosts(SOURCE, { fetch: supabase.fetch, pageSize: 2 });

  assert.deepEqual(rows, [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, { slug: 'd' }, { slug: 'e' }]);
  assert.deepEqual(
    supabase.requests.map(({ url }) => url.searchParams.get('offset')),
    ['0', '2', '4'],
  );
  const [first] = supabase.requests;
  assert.equal(first.url.origin + first.url.pathname, 'https://peakodds.supabase.co/rest/v1/posts');
  assert.equal(first.url.searchParams.get('status'), 'eq.published');
  assert.equal(first.url.searchParams.get('order'), 'slug.asc');
  assert.equal(first.url.searchParams.get('limit'), '2');
  assert.match(first.url.searchParams.get('select') ?? '', /edition_id/);
  assert.deepEqual(first.init?.headers, { apikey: 'sb_publishable_test', Accept: 'application/json' });
  assert.ok(first.init?.signal instanceof AbortSignal, 'every request is bounded by a timeout');
});

test('a full last page is followed by one more request that comes back empty', async () => {
  const supabase = fakeSupabase([[{ slug: 'a' }, { slug: 'b' }], []]);
  assert.equal((await fetchPublishedPosts(SOURCE, { fetch: supabase.fetch, pageSize: 2 })).length, 2);
  assert.equal(supabase.requests.length, 2);
});

test('a refused query fails with the status and Supabase’s answer', async () => {
  const fetch = async () => new Response('{"message":"permission denied for table posts"}', { status: 401 });
  await assert.rejects(
    fetchPublishedPosts(SOURCE, { fetch }),
    { message: 'Supabase posts query failed (HTTP 401): {"message":"permission denied for table posts"}' },
  );
});

test('a query that times out fails naming the limit', async () => {
  const fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  await assert.rejects(fetchPublishedPosts(SOURCE, { fetch }), {
    message: `Supabase did not answer the posts query within ${FETCH_TIMEOUT_MS} ms`,
  });
});

test('the content source comes from the PeakOdds variables, without a trailing slash', () => {
  assert.deepEqual(
    contentSourceFromEnv({
      PEAKODDS_SUPABASE_URL: ' https://peakodds.supabase.co/ ',
      PEAKODDS_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    }),
    SOURCE,
  );
});

test('a missing or empty Supabase variable fails the build naming it', () => {
  assert.throws(() => contentSourceFromEnv({}), /^Error: Missing PEAKODDS_SUPABASE_URL and PEAKODDS_SUPABASE_PUBLISHABLE_KEY\./);
  assert.throws(
    () => contentSourceFromEnv({ PEAKODDS_SUPABASE_URL: 'https://peakodds.supabase.co', PEAKODDS_SUPABASE_PUBLISHABLE_KEY: '' }),
    /^Error: Missing PEAKODDS_SUPABASE_PUBLISHABLE_KEY\./,
  );
  assert.throws(
    () => contentSourceFromEnv({ PEAKODDS_SUPABASE_URL: '  ', PEAKODDS_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }),
    /^Error: Missing PEAKODDS_SUPABASE_URL\./,
  );
});
