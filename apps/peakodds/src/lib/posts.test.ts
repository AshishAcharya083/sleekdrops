import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_CACHE_FILE, getEditionPosts, getPost, loadPosts, parsePostRows } from './posts.ts';

/** A published `posts` row as the Supabase Data API returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'swans-v-giants-preview',
    title: 'Swans v Giants preview',
    category: 'AFL',
    post_type: 'preview',
    author: 'PeakOdds Editorial Team',
    pub_date: '2026-07-16',
    updated_date: null,
    edition_id: 'au',
    event_starts_at: '2026-07-18T09:35:00+00:00',
    odds_as_at: '2026-07-16T01:00:00+00:00',
    frontmatter_json: { title: 'Swans v Giants preview', dek: 'Where the market may be wrong.', tags: ['AFL', 'Round 19'] },
    body_md: '## The picks\n\nGambling Help Online: 1800 858 858',
    ...overrides,
  };
}

test('a row becomes a typed post with its dek, tags, sport and event times', () => {
  const [post] = parsePostRows([row()]);
  assert.deepEqual(post, {
    slug: 'swans-v-giants-preview',
    title: 'Swans v Giants preview',
    description: 'Where the market may be wrong.',
    sport: 'AFL',
    postType: 'preview',
    editionId: 'au',
    author: 'PeakOdds Editorial Team',
    tags: ['AFL', 'Round 19'],
    pubDate: '2026-07-16',
    updatedDate: null,
    eventStartsAt: new Date('2026-07-18T09:35:00Z'),
    oddsAsAt: new Date('2026-07-16T01:00:00Z'),
    body: '## The picks\n\nGambling Help Online: 1800 858 858',
  });
});

test('a post with no dek, tags or event has empty defaults rather than missing fields', () => {
  const [post] = parsePostRows([
    row({ post_type: 'guide', event_starts_at: null, odds_as_at: null, frontmatter_json: '{"title":"How odds work"}' }),
  ]);
  assert.equal(post.description, '');
  assert.deepEqual(post.tags, []);
  assert.equal(post.eventStartsAt, null);
  assert.equal(post.oddsAsAt, null);
});

test('posts are listed newest published day first, then by slug', () => {
  const posts = parsePostRows([
    row({ slug: 'b-older', pub_date: '2026-07-01' }),
    row({ slug: 'z-newest', pub_date: '2026-07-20' }),
    row({ slug: 'a-older', pub_date: '2026-07-01' }),
  ]);
  assert.deepEqual(
    posts.map((post) => post.slug),
    ['z-newest', 'a-older', 'b-older'],
  );
});

test('a post with no edition fails the build naming the slug', () => {
  assert.throws(() => parsePostRows([row({ slug: 'orphan-preview', edition_id: null })]), {
    message: "PeakOdds post 'orphan-preview' has no edition_id",
  });
  assert.throws(() => parsePostRows([row({ slug: 'orphan-preview', edition_id: undefined })]), /'orphan-preview' has no edition_id/);
});

test('a post with an unknown edition fails the build naming the slug and the edition', () => {
  assert.throws(() => parsePostRows([row({ slug: 'uk-preview', edition_id: 'uk' })]), {
    message: "PeakOdds post 'uk-preview' has an unknown edition_id 'uk'",
  });
});

test('a malformed column fails the build naming the post and the column', () => {
  assert.throws(() => parsePostRows([row({ post_type: 'review' })]), /'swans-v-giants-preview' has an unknown post_type 'review'/);
  assert.throws(() => parsePostRows([row({ pub_date: '16/07/2026' })]), /'swans-v-giants-preview' has a pub_date that is not a YYYY-MM-DD date/);
  assert.throws(() => parsePostRows([row({ event_starts_at: 'soon' })]), /has a event_starts_at that is not a timestamp/);
  assert.throws(() => parsePostRows([row({ frontmatter_json: '{' })]), /has a frontmatter_json that is not valid JSON/);
});

test('a missing content cache fails with the command that fills it', async () => {
  await assert.rejects(loadPosts('/nonexistent/posts.json'), /No PeakOdds content at \/nonexistent\/posts.json\. Run `pnpm --filter @sleekdrops\/peakodds fetch-content` first\./);
});

test('pages read only their own edition’s posts from the content cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peakodds-posts-'));
  const previousCwd = process.cwd();
  try {
    await mkdir(join(root, '.content-cache'));
    await writeFile(
      join(root, CONTENT_CACHE_FILE),
      JSON.stringify([
        row({ slug: 'swans-v-giants-preview', edition_id: 'au' }),
        row({ slug: 'arsenal-v-chelsea-preview', edition_id: 'global', category: 'Football' }),
      ]),
    );
    process.chdir(root);

    assert.deepEqual(
      (await getEditionPosts('au')).map((post) => post.slug),
      ['swans-v-giants-preview'],
    );
    assert.equal((await getPost('global', 'arsenal-v-chelsea-preview'))?.sport, 'Football');
    assert.equal(await getPost('au', 'arsenal-v-chelsea-preview'), undefined);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
