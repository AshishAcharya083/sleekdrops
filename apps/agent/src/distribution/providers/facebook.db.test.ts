// The Facebook adapter against a mocked Graph API and real queue rows.
//
// The Graph API is stubbed at `fetch`, so every assertion is about the request
// this adapter actually builds - which edge it posts to, what it puts in the
// form body, and which header the token travels in. Everything else is real:
// the connection row, the queue rows the monthly counter is derived from, the
// settings row the quota correction is written to, and the worker's own
// `processItem`, which is the only caller a provider ever has.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SITE_URL = 'https://sleekdrops.com';

const TOKEN = 'EAAG-page-token-4f21c9d7';
const TOKEN_REF = 'facebook-test-page-token';
process.env.FACEBOOK_TEST_PAGE_TOKEN = TOKEN;

const { pool, q, getSetting, setSetting } = await import('../../db/pool.js');
const { migrate } = await import('../../db/migrate.js');
const { config } = await import('../../config.js');
const { enqueuePublishedArticle, getItem, storeRenderedPayload, taggedUrl } = await import(
  '../queue.js'
);
const { processItem } = await import('../worker.js');
const { PermanentProviderError } = await import('../types.js');
const { BODY_LINK_BUDGET_SETTING, createFacebookProvider, FACEBOOK_PROVIDER } = await import(
  './facebook.js'
);

import type { PayloadRenderer } from './facebook.js';
import type {
  DistributableArticle,
  DistributionItem,
  LinkPlacement,
  RenderedPayload,
  SocialProvider,
} from '../types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

const TITLE = 'The headphones for a quiet commute';
const HERO = 'https://storage.googleapis.com/images/heroes/quiet.png';
const CARD = 'https://storage.googleapis.com/images/social/quiet-facebook.png';

const articles: string[] = [];
const connections: string[] = [];

after(async () => {
  if (reachable) {
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

// ── The mocked Graph API ───────────────────────────────────────────────────

interface RecordedCall {
  path: string;
  method: string;
  params: Record<string, string>;
  /** The whole request URL, so a test can prove the token is not in it. */
  url: string;
  authorization: string | null;
}

interface Reply {
  status?: number;
  body: unknown;
}

type Route = [RegExp, (call: RecordedCall) => Reply];

/** A Graph error in the envelope the real API uses. */
function graphError(message: string, code: number, status = 400): Reply {
  return { status, body: { error: { message, type: 'OAuthException', code } } };
}

/** A token Meta is happy with. `expiresAt` 0 is its "this one never expires". */
function debugToken(expiresAt = 0, isValid = true): Route {
  return [/^GET debug_token$/, () => ({ body: { data: { is_valid: isValid, expires_at: expiresAt } } })];
}

function mockGraph(routes: Route[]): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(`/${config.facebook.graphVersion}/`, '');
    const params =
      method === 'POST'
        ? Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
        : Object.fromEntries(url.searchParams);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      path,
      method,
      params,
      url: url.toString(),
      authorization: headers.Authorization ?? null,
    };
    calls.push(call);
    const route = routes.find(([match]) => match.test(`${method} ${path}`));
    const reply: Reply = route
      ? route[1](call)
      : graphError(`no stub for ${method} ${path}`, 803, 404);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const posted = (call: RecordedCall | undefined): Record<string, string> => call?.params ?? {};

// ── Rows, as the publish stage leaves them ─────────────────────────────────

async function connect(): Promise<{ id: string; pageId: string }> {
  const pageId = `1000${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref, display_name)
     VALUES ($1, $2, $3, 'Sleekdrops') RETURNING id`,
    [FACEBOOK_PROVIDER, pageId, TOKEN_REF],
  );
  connections.push(row.id);
  return { id: row.id, pageId };
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

/** One queued item on one connected Page, as the worker would claim it. */
async function queued(): Promise<{ item: DistributionItem; pageId: string; connectionId: string }> {
  const connection = await connect();
  const piece = await article();
  await enqueuePublishedArticle(piece, { d1Status: 'published' });
  const [row] = await q<{ id: string }>(
    'SELECT id FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [piece.slug, connection.id],
  );
  const item = await getItem(row.id);
  assert.ok(item, 'the publish stage queued an item for the Page');
  return { item, pageId: connection.pageId, connectionId: connection.id };
}

/** A body-link post this Page already spent this month. */
async function spentBodyLink(connectionId: string, articleId: string): Promise<void> {
  await q(
    `INSERT INTO distribution_queue
       (article_id, slug, channel_connection_id, provider, payload, placement, status, posted_at,
        remote_post_id)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, 'in_body', 'posted', now(), 'spent')`,
    [articleId, `spent-${randomUUID().slice(0, 8)}`, connectionId, FACEBOOK_PROVIDER],
  );
}

// ── The payload, as the renderer hands it over ─────────────────────────────

function payload(item: DistributionItem, placement: LinkPlacement, imageUrl: string | null): RenderedPayload {
  const url = taggedUrl(item.slug, FACEBOOK_PROVIDER, placement);
  return {
    caption:
      placement === 'in_body'
        ? `The $399 Bose is the one to buy under $400.\n\n${url}`
        : 'The $399 Bose is the one to buy under $400.\n\nLink in the first comment.',
    url,
    placement,
    commentText: url,
    imageUrl,
    imageSource: imageUrl ? 'generated' : 'found',
    renderedAt: new Date().toISOString(),
    expected: { ogTitle: TITLE, ogImage: HERO },
  };
}

/**
 * The renderer as a stub: `first` is what a re-composition for the first
 * comment produces, and null is the case the ladder has to park - an article
 * with no image we may upload, so the re-render resolves straight back to a
 * body link.
 */
function renderer(shipped: RenderedPayload, recomposed?: RenderedPayload | null): PayloadRenderer {
  return {
    forItem: async () => shipped,
    forPlacement: async () => recomposed ?? null,
  };
}

function facebook(
  fetch: typeof globalThis.fetch,
  payloads: PayloadRenderer,
  now = () => new Date(),
): SocialProvider {
  return createFacebookProvider({ fetch, renderer: payloads, now, sleep: async () => {} });
}

// ── first_comment ──────────────────────────────────────────────────────────

test('first_comment posts the photo, then the link under it', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'first_comment', CARD);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { id: '77', post_id: `${pageId}_900` } })],
    [new RegExp(`^POST ${pageId}_900/comments$`), () => ({ body: { id: 'c1' } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.remotePostId, `${pageId}_900`);
  assert.equal(receipt.degraded, undefined);

  const photo = posted(calls.find((call) => call.path.endsWith('/photos')));
  assert.equal(photo.url, CARD, 'the image we may upload goes up natively');
  assert.equal(photo.caption, shipped.caption);
  assert.equal(photo.published, 'true');
  assert.equal(
    posted(calls.find((call) => call.path.endsWith('/comments'))).message,
    shipped.commentText,
  );
  assert.equal(
    // debug_token is the one call whose subject is the token itself, so it is
    // the one call that may name it in a parameter.
    calls.filter((call) => call.path !== 'debug_token').every((call) => !call.url.includes(TOKEN)),
    true,
    'the token travels in the Authorization header, never in a posting URL',
  );
  assert.equal(
    calls.find((call) => call.path.endsWith('/photos'))?.authorization,
    `Bearer ${TOKEN}`,
  );
});

test('a first comment that will not go up is appended to the caption', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'first_comment', CARD);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_901` } })],
    [
      new RegExp(`^POST ${pageId}_901/comments$`),
      () => graphError('Please reduce the amount of data', 1, 500),
    ],
    [new RegExp(`^POST ${pageId}_901$`), () => ({ body: { success: true } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.remotePostId, `${pageId}_901`);
  assert.equal(receipt.degraded, true);
  assert.match(receipt.note ?? '', /appended to the caption/);
  assert.equal(
    calls.filter((call) => call.path.endsWith('/comments')).length,
    3,
    'the comment is retried before the caption is edited',
  );
  const edit = posted(calls.find((call) => call.path === `${pageId}_901` && call.method === 'POST'));
  assert.equal(edit.message, `${shipped.caption}\n\n${shipped.url}`);
});

test('a missing engagement scope skips the comment retries', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'first_comment', CARD);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_902` } })],
    [
      new RegExp(`^POST ${pageId}_902/comments$`),
      () => graphError('(#200) Requires pages_manage_engagement permission', 200, 403),
    ],
    [new RegExp(`^POST ${pageId}_902$`), () => ({ body: { success: true } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.degraded, true);
  assert.match(receipt.note ?? '', /pages_manage_engagement/);
  assert.equal(calls.filter((call) => call.path.endsWith('/comments')).length, 1);
});

test('a post nothing could put a link on is reported, never retried', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'first_comment', CARD);
  const { fetch } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_903` } })],
    [new RegExp(`^POST ${pageId}_903/comments$`), () => graphError('temporary failure', 2, 500)],
    [new RegExp(`^POST ${pageId}_903$`), () => graphError('temporary failure', 2, 500)],
  ]);

  const receipt = await facebook(fetch, renderer(shipped)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  // The post is live. Throwing here would repost the article on the retry.
  assert.equal(receipt.remotePostId, `${pageId}_903`);
  assert.equal(receipt.degraded, true);
  assert.match(receipt.note ?? '', /no link in it - add one by hand/);
});

// ── in_body and the monthly budget ─────────────────────────────────────────

test('in_body posts one link post and lets Meta scrape the card', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'in_body', null);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/feed$`), () => ({ body: { id: `${pageId}_910` } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.remotePostId, `${pageId}_910`);
  const feed = posted(calls.find((call) => call.path.endsWith('/feed')));
  assert.equal(feed.link, shipped.url);
  assert.equal(feed.message, shipped.caption);
  assert.equal(calls.some((call) => call.path.endsWith('/photos')), false);
});

test('a spent monthly budget places the link in the comment instead', { skip }, async () => {
  const { item, pageId, connectionId } = await queued();
  await spentBodyLink(connectionId, item.articleId!);
  await spentBodyLink(connectionId, item.articleId!);
  assert.equal(config.facebook.bodyLinkCap, 2);

  const shipped = payload(item, 'in_body', null);
  const recomposed = payload(item, 'first_comment', CARD);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_920` } })],
    [new RegExp(`^POST ${pageId}_920/comments$`), () => ({ body: { id: 'c1' } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped, recomposed)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.remotePostId, `${pageId}_920`);
  assert.equal(
    calls.some((call) => call.path.endsWith('/feed')),
    false,
    'no post is spent on a rejection the rows already predicted',
  );
});

test('a quota rejection beats the local count and corrects it', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'in_body', null);
  const recomposed = payload(item, 'first_comment', CARD);
  const { fetch, calls } = mockGraph([
    debugToken(),
    [
      new RegExp(`^POST ${pageId}/feed$`),
      () =>
        graphError(
          'This Page has reached the limit of link posts it can publish this month.',
          368,
          403,
        ),
    ],
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_930` } })],
    [new RegExp(`^POST ${pageId}_930/comments$`), () => ({ body: { id: 'c1' } })],
  ]);

  const receipt = await facebook(fetch, renderer(shipped, recomposed)).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  assert.equal(receipt.remotePostId, `${pageId}_930`, 'the item still went out, in the other placement');
  assert.equal(calls.filter((call) => call.path.endsWith('/feed')).length, 1);

  const state = await getSetting<Record<string, { month: string }>>(BODY_LINK_BUDGET_SETTING, {});
  assert.equal(state[pageId]?.month, new Date().toISOString().slice(0, 7));

  // And the correction sticks: the next item for this Page, whose rows still
  // say the budget is untouched, never reaches the feed edge again.
  const next = await queued();
  const second = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_931` } })],
    [new RegExp(`^POST ${pageId}_931/comments$`), () => ({ body: { id: 'c1' } })],
  ]);
  await facebook(
    second.fetch,
    renderer(payload(next.item, 'in_body', null), payload(next.item, 'first_comment', CARD)),
  ).post({ accessToken: TOKEN, externalAccountId: pageId, item: next.item });
  assert.equal(second.calls.some((call) => call.path.endsWith('/feed')), false);

  await setSetting(BODY_LINK_BUDGET_SETTING, {});
});

// ── The ladder's last rung, through the worker ─────────────────────────────

test('no image and no budget holds the item for an operator', { skip }, async () => {
  const { item, pageId, connectionId } = await queued();
  await spentBodyLink(connectionId, item.articleId!);
  await spentBodyLink(connectionId, item.articleId!);

  const { fetch, calls } = mockGraph([debugToken()]);
  // No re-composition is possible: the hero is a third party's photograph and
  // the social card could not be rendered, so there is no image to upload.
  const provider = facebook(fetch, renderer(payload(item, 'in_body', null), null));

  const outcome = await processItem(item, {
    resolveProvider: () => provider,
    fetchPage: async () => ({
      status: 200,
      body: `<meta property="og:title" content="${TITLE} | SleekDrops" />
             <meta property="og:image" content="${HERO}" />`,
    }),
  });

  assert.equal(outcome, 'held');
  const held = await getItem(item.id);
  assert.equal(held?.status, 'held');
  assert.match(held?.lastError ?? '', /no image we may upload/);
  assert.equal(held?.remotePostId, null);
  assert.equal(
    calls.some((call) => call.path.endsWith('/feed') || call.path.endsWith('/photos')),
    false,
    'nothing was posted',
  );
  assert.equal(pageId.length > 0, true);
});

test('the worker posts a first-comment item end to end', { skip }, async () => {
  const { item, pageId } = await queued();
  const shipped = payload(item, 'first_comment', CARD);
  const { fetch } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_940` } })],
    [new RegExp(`^POST ${pageId}_940/comments$`), () => ({ body: { id: 'c1' } })],
  ]);

  const outcome = await processItem(item, {
    resolveProvider: () => facebook(fetch, renderer(shipped)),
    fetchPage: async () => ({
      status: 200,
      body: `<meta property="og:title" content="${TITLE} | SleekDrops" />
             <meta property="og:image" content="${HERO}" />`,
    }),
  });

  assert.equal(outcome, 'posted');
  const done = await getItem(item.id);
  assert.equal(done?.status, 'posted');
  assert.equal(done?.remotePostId, `${pageId}_940`);
});

test('the adapter reads its payload off the row it was queued with', { skip }, async () => {
  const { item, pageId } = await queued();
  // No renderer stub here: this is the real one, reading the article row and
  // keeping the payload the per-channel renderer already wrote.
  const shipped = payload(item, 'first_comment', CARD);
  await storeRenderedPayload(item.id, shipped);
  const stored = await getItem(item.id);
  assert.ok(stored);

  const { fetch, calls } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/photos$`), () => ({ body: { post_id: `${pageId}_970` } })],
    [new RegExp(`^POST ${pageId}_970/comments$`), () => ({ body: { id: 'c1' } })],
  ]);

  const receipt = await createFacebookProvider({ fetch, sleep: async () => {} }).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item: stored,
  });

  assert.equal(receipt.remotePostId, `${pageId}_970`);
  assert.equal(posted(calls.find((call) => call.path.endsWith('/photos'))).caption, shipped.caption);
  assert.equal(
    posted(calls.find((call) => call.path.endsWith('/comments'))).message,
    shipped.commentText,
  );
});

// ── Tokens ─────────────────────────────────────────────────────────────────

test('the token expiry is written back on every call', { skip }, async () => {
  const { item, pageId, connectionId } = await queued();
  const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
  const { fetch } = mockGraph([
    debugToken(expiresAt),
    [new RegExp(`^POST ${pageId}/feed$`), () => ({ body: { id: `${pageId}_950` } })],
  ]);

  await facebook(fetch, renderer(payload(item, 'in_body', null))).post({
    accessToken: TOKEN,
    externalAccountId: pageId,
    item,
  });

  const [row] = await q<{ expires_at: string; status: string }>(
    'SELECT expires_at, status FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  const written = new Date(row.expires_at).getTime();
  assert.equal(Math.abs(written - expiresAt * 1_000) < 60_000, true, 'the expiry Meta reported');
  assert.equal(row.status, 'active');
});

test('a token Meta no longer honours sets the connection status', { skip }, async () => {
  const { item, pageId, connectionId } = await queued();
  const { fetch } = mockGraph([debugToken(0, false)]);

  await assert.rejects(
    facebook(fetch, renderer(payload(item, 'in_body', null))).post({
      accessToken: TOKEN,
      externalAccountId: pageId,
      item,
    }),
    (err: unknown) => {
      assert.equal(err instanceof PermanentProviderError, true);
      assert.match((err as Error).message, new RegExp(TOKEN_REF));
      assert.equal((err as Error).message.includes(TOKEN), false, 'never the token itself');
      return true;
    },
  );

  const [row] = await q<{ status: string }>(
    'SELECT status FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  assert.equal(row.status, 'needs_reauth');
});

test('a rejected token on the post itself is permanent and actionable', { skip }, async () => {
  const { item, pageId, connectionId } = await queued();
  const { fetch } = mockGraph([
    // debug_token is not stubbed: Meta refuses it without an app token, which
    // must never be what stops a post going out.
    [
      new RegExp(`^POST ${pageId}/feed$`),
      () => graphError('Error validating access token: Session has expired.', 190, 401),
    ],
  ]);

  await assert.rejects(
    facebook(fetch, renderer(payload(item, 'in_body', null))).post({
      accessToken: TOKEN,
      externalAccountId: pageId,
      item,
    }),
    (err: unknown) => {
      assert.equal(err instanceof PermanentProviderError, true);
      assert.match((err as Error).message, /pages_manage_posts/);
      return true;
    },
  );

  const [row] = await q<{ status: string }>(
    'SELECT status FROM channel_connections WHERE id = $1',
    [connectionId],
  );
  assert.equal(row.status, 'needs_reauth');
});

test('an error that echoes the token never carries it out', { skip }, async () => {
  const { item, pageId } = await queued();
  const { fetch } = mockGraph([
    debugToken(),
    [
      new RegExp(`^POST ${pageId}/feed$`),
      () => graphError(`Invalid OAuth access token "${TOKEN}" for this Page`, 190, 401),
    ],
  ]);

  await assert.rejects(
    facebook(fetch, renderer(payload(item, 'in_body', null))).post({
      accessToken: TOKEN,
      externalAccountId: pageId,
      item,
    }),
    (err: unknown) => {
      assert.equal((err as Error).message.includes(TOKEN), false);
      assert.match((err as Error).message, /redacted/);
      return true;
    },
  );
});

test('a rate limit is retryable, not terminal', { skip }, async () => {
  const { item, pageId } = await queued();
  const { fetch } = mockGraph([
    debugToken(),
    [new RegExp(`^POST ${pageId}/feed$`), () => graphError('(#32) Page request limit reached', 32, 429)],
  ]);

  await assert.rejects(
    facebook(fetch, renderer(payload(item, 'in_body', null))).post({
      accessToken: TOKEN,
      externalAccountId: pageId,
      item,
    }),
    (err: unknown) => {
      assert.equal(err instanceof PermanentProviderError, false);
      assert.match((err as Error).message, /request limit reached/);
      return true;
    },
  );
});

// ── Insights ───────────────────────────────────────────────────────────────

test('fetchInsights returns the three aggregate counters and nothing else', { skip }, async () => {
  const { pageId } = await queued();
  const { fetch, calls } = mockGraph([
    debugToken(),
    [
      /^GET \d+_960\/insights$/,
      () => ({
        body: {
          data: [
            { name: 'post_impressions', values: [{ value: 412 }] },
            { name: 'post_clicks', values: [{ value: 19 }] },
            { name: 'post_reactions_by_type_total', values: [{ value: { like: 7, love: 2 } }] },
          ],
        },
      }),
    ],
  ]);

  const snapshot = await facebook(fetch, renderer({} as RenderedPayload)).fetchInsights({
    accessToken: TOKEN,
    externalAccountId: pageId,
    remotePostId: `${pageId}_960`,
  });

  assert.deepEqual(
    { impressions: snapshot.impressions, clicks: snapshot.clicks, reactions: snapshot.reactions },
    { impressions: 412, clicks: 19, reactions: 9 },
  );
  assert.equal(Number.isFinite(Date.parse(snapshot.fetchedAt)), true);
  assert.equal(
    posted(calls.find((call) => call.path.endsWith('/insights'))).metric,
    'post_impressions,post_clicks,post_reactions_by_type_total',
  );
});

test('an insight the Page does not report reads as null, not zero', { skip }, async () => {
  const { pageId } = await queued();
  const { fetch } = mockGraph([
    debugToken(),
    [/insights$/, () => ({ body: { data: [{ name: 'post_impressions', values: [{ value: 5 }] }] } })],
  ]);

  const snapshot = await facebook(fetch, renderer({} as RenderedPayload)).fetchInsights({
    accessToken: TOKEN,
    externalAccountId: pageId,
    remotePostId: `${pageId}_961`,
  });

  assert.deepEqual(
    { impressions: snapshot.impressions, clicks: snapshot.clicks, reactions: snapshot.reactions },
    { impressions: 5, clicks: null, reactions: null },
  );
});

// ── Connecting ─────────────────────────────────────────────────────────────

test('authenticate takes a Page token and reads the Page off it', { skip }, async () => {
  const { fetch } = mockGraph([
    debugToken(),
    [/^GET me$/, () => ({ body: { id: '1001', name: 'Sleekdrops', category: 'Product/Service' } })],
  ]);

  const details = await facebook(fetch, renderer({} as RenderedPayload)).authenticate({
    token: TOKEN,
  });

  assert.deepEqual(
    { id: details.externalAccountId, name: details.displayName, expiresIn: details.expiresIn },
    { id: '1001', name: 'Sleekdrops', expiresIn: null },
  );
  assert.equal(details.accessToken, TOKEN);
});

test('a user token is followed to the one Page it administers', { skip }, async () => {
  const { fetch } = mockGraph([
    debugToken(),
    [/^GET me$/, () => graphError('(#100) nonexisting field (category) on node type (User)', 100)],
    [
      /^GET me\/accounts$/,
      () => ({ body: { data: [{ id: '1002', name: 'Sleekdrops', access_token: 'page-token' }] } }),
    ],
  ]);

  const details = await facebook(fetch, renderer({} as RenderedPayload)).authenticate({
    token: TOKEN,
  });

  assert.equal(details.externalAccountId, '1002');
  assert.equal(details.accessToken, 'page-token', 'the Page token, not the user token');
});

test('a token Graph will not read is reported with what to do about it', { skip }, async () => {
  const { fetch } = mockGraph([
    [/^GET me$/, () => graphError('(#100) nonexisting field (category) on node type (User)', 100)],
    [/^GET me\/accounts$/, () => graphError('Error validating access token', 190, 401)],
  ]);

  await assert.rejects(
    facebook(fetch, renderer({} as RenderedPayload)).authenticate({ token: TOKEN }),
    (err: unknown) => {
      assert.equal(err instanceof PermanentProviderError, true);
      assert.match((err as Error).message, /pages_manage_engagement/);
      return true;
    },
  );
});

test('authenticate says what it needs when there is no token', { skip }, async () => {
  const { fetch } = mockGraph([]);
  await assert.rejects(
    facebook(fetch, renderer({} as RenderedPayload)).authenticate({ code: 'oauth-code' }),
    /Page access token/,
  );
});

test('refreshToken re-reads the Page when no app credentials are configured', { skip }, async () => {
  const { fetch, calls } = mockGraph([
    debugToken(),
    [/^GET me$/, () => ({ body: { id: '1003', name: 'Sleekdrops', category: 'Publisher' } })],
  ]);

  const details = await facebook(fetch, renderer({} as RenderedPayload)).refreshToken(TOKEN);

  assert.equal(details.externalAccountId, '1003');
  assert.equal(details.accessToken, TOKEN);
  assert.equal(
    calls.some((call) => call.path === 'oauth/access_token'),
    false,
    'there is no refresh grant for a Page token without app credentials',
  );
});
