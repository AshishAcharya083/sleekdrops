// The renderer against a real row, driven the way a provider adapter drives
// it: take the queued item, read the article it points at, render for that
// item's channel and placement, and write the result back onto the row.
//
// The unit tests hand `render` an article literal. This one hands it a
// `SELECT * FROM articles` row, because that is what the caller has, and the
// two fields the composition turns on - `hero_image_source` and the intent
// inside `keyword_plan` - are a text column and a JSONB column respectively.
// A literal cannot tell us they line up; a row can. The payload then goes back
// through JSONB, where the resolved placement has to survive.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SITE_URL = 'https://sleekdrops.com';

const { pool, q } = await import('../../db/pool.js');
const { migrate } = await import('../../db/migrate.js');
const { enqueuePublishedArticle } = await import('../queue.js');
const { toDistributionItem } = await import('../types.js');
const { render, AFFILIATE_DISCLOSURE, FIRST_COMMENT_CUE } = await import('./index.js');

import type { CopyWriter } from './copy.js';
import type { DistributableArticle, DistributionItem, DistributionQueueRow } from '../types.js';

const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();

/**
 * The real provider name, because the channel is half of what is being tested:
 * an adapter renders for the network its connection names, and the caption
 * budget and the first-comment support come off that name. Rows are scoped by
 * (slug, connection) rather than by a unique provider for the same reason -
 * a stub name would be an unregistered channel and would exercise the
 * fail-safe default instead of Facebook.
 */
const PROVIDER = 'facebook';
const articles: string[] = [];
const connections: string[] = [];

after(async () => {
  if (reachable) {
    await q('DELETE FROM channel_connections WHERE id = ANY($1)', [connections]);
    await q('DELETE FROM articles WHERE id = ANY($1)', [articles]);
  }
  await pool.end();
});

async function connect(provider: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO channel_connections (provider, external_account_id, token_ref)
     VALUES ($1, $2, 'test-channel-token')
     RETURNING id`,
    [provider, `account-${randomUUID().slice(0, 8)}`],
  );
  connections.push(row.id);
  return row.id;
}

/** A published article as the pipeline leaves it, read back out of the table. */
async function publishedArticle(fields: {
  heroSource: string | null;
  intent: string;
}): Promise<DistributableArticle> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO articles
       (title, slug, category, post_type, stage, status, frontmatter, keyword_plan, hero_image_source)
     VALUES ('The headphones for a quiet commute', $1, 'Tech', 'guide', 'publish', 'queued',
             $2::jsonb, $3::jsonb, $4)
     RETURNING id`,
    [
      `quiet-commutes-${randomUUID().slice(0, 8)}`,
      JSON.stringify({
        title: 'The headphones for a quiet commute',
        dek: 'The noise floor drops 12 dB on the 7:12, and the $399 Bose is the one to buy under $400.',
        heroImage: 'https://storage.googleapis.com/images/heroes/quiet.png',
      }),
      JSON.stringify({ primaryKeyword: 'best noise cancelling headphones', intent: fields.intent }),
      fields.heroSource,
    ],
  );
  articles.push(row.id);
  const [stored] = await q<DistributableArticle>('SELECT * FROM articles WHERE id = $1', [row.id]);
  return stored;
}

/** The item as the worker hands it to an adapter: one row, read back as read. */
async function queuedItem(slug: string, connectionId: string): Promise<DistributionItem> {
  const [row] = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE slug = $1 AND channel_connection_id = $2',
    [slug, connectionId],
  );
  assert.ok(row, 'the publish stage queued nothing for this channel');
  return toDistributionItem(row);
}

const writeCopy: CopyWriter = async () =>
  'The $549 Sony XM6 leads on the 7:12; the $399 Bose is the one to buy under $400.';

const renderCard = async () => ({ data: Buffer.from('card-bytes'), mimeType: 'image/png' });
const uploadCard = async (objectName: string) =>
  `https://storage.googleapis.com/images/${objectName}`;

test('a queued item renders from its own article row', { skip }, async () => {
  const connection = await connect(PROVIDER);
  const article = await publishedArticle({
    heroSource: 'generated',
    intent: 'Commercial Investigation',
  });

  await enqueuePublishedArticle(article, { d1Status: 'published' });
  const item = await queuedItem(article.slug!, connection);
  assert.equal(item.provider, PROVIDER);
  assert.equal(item.placement, 'first_comment', 'the configured default');

  const payload = await render(article, item.provider, item.placement, {
    writeCopy,
    renderCard,
    uploadCard,
  });

  assert.ok(payload.caption.includes(FIRST_COMMENT_CUE), 'the row is placed in a first comment');
  assert.ok(payload.caption.includes(AFFILIATE_DISCLOSURE), 'the stored intent is a monetised one');
  assert.equal(
    payload.imageUrl,
    'https://storage.googleapis.com/images/heroes/quiet.png',
    'the stored hero_image_source says we made this one',
  );
  assert.equal(payload.placement, 'first_comment');

  // What the adapter does with it: write the rendered post back onto the row.
  await q('UPDATE distribution_queue SET payload = $2::jsonb WHERE id = $1', [
    item.id,
    JSON.stringify(payload),
  ]);
  const [stored] = await q<DistributionQueueRow>(
    'SELECT * FROM distribution_queue WHERE id = $1',
    [item.id],
  );
  assert.deepEqual(stored.payload, payload, 'the payload survives the JSONB round trip');
  assert.equal(stored.payload.placement, 'first_comment');
});

test('an unmonetised article on a found hero renders neither', { skip }, async () => {
  const connection = await connect(PROVIDER);
  const article = await publishedArticle({ heroSource: 'found', intent: 'Informational' });

  await enqueuePublishedArticle(article, { d1Status: 'published' });
  const item = await queuedItem(article.slug!, connection);

  const payload = await render(article, item.provider, item.placement, {
    writeCopy,
    renderCard,
    uploadCard,
  });

  assert.ok(!payload.caption.includes(AFFILIATE_DISCLOSURE), 'nothing here is an endorsement');
  assert.equal(payload.imageSource, 'found', 'the provenance came off the column');
  assert.notEqual(
    payload.imageUrl,
    'https://storage.googleapis.com/images/heroes/quiet.png',
    "someone else's photograph is never what we hand the network",
  );
  assert.match(payload.imageUrl ?? '', /\/social\//, 'a card we rendered went instead');
});
