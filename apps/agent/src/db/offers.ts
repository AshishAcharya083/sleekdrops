// Reading and writing per-offer records.
//
// Dates come back through `to_char` rather than as Date objects: an "as at"
// stamp is a calendar day the publication states, and letting node-postgres
// hand it over as a Date would re-interpret that day in the server's timezone
// on the way out.
//
// Every save also appends a revision. That is what makes the feed overwrite
// non-destructive: when a SKU finally appears in a feed, the row an editor
// filled in on announcement day stops being what the page shows and starts
// being the history of what it showed.
import { pool, q } from './pool.js';
import type { OfferInput, ProductOffer, ProductOfferRevision } from '../pipeline/types.js';

const OFFER_COLUMNS = `
  id, article_id, go_slug, product_name, url, price::text AS price, currency,
  to_char(price_observed_on, 'YYYY-MM-DD') AS price_observed_on,
  preorder, to_char(release_date, 'YYYY-MM-DD') AS release_date,
  merchant, source, entered_by, note, created_at, updated_at`;

const REVISION_COLUMNS = `
  id, go_slug, url, price::text AS price, currency,
  to_char(price_observed_on, 'YYYY-MM-DD') AS price_observed_on,
  preorder, to_char(release_date, 'YYYY-MM-DD') AS release_date,
  merchant, source, entered_by, saved_at`;

/** The offers attached to one card, in the order they were first attached. */
export async function offersForArticle(articleId: string): Promise<ProductOffer[]> {
  return q<ProductOffer>(
    `SELECT ${OFFER_COLUMNS} FROM product_offers WHERE article_id = $1 ORDER BY created_at, go_slug`,
    [articleId],
  );
}

/** Every version ever saved for one card's offers, newest first. */
export async function offerRevisionsForArticle(
  articleId: string,
): Promise<ProductOfferRevision[]> {
  return q<ProductOfferRevision>(
    `SELECT ${REVISION_COLUMNS} FROM product_offer_revisions
      WHERE article_id = $1 ORDER BY saved_at DESC, id`,
    [articleId],
  );
}

/**
 * Write an offer and record the version. One transaction: a save that lands
 * without its revision would be exactly the lost history this table exists to
 * prevent.
 *
 * `product_name` is only overwritten when the caller supplies one, so a feed
 * sync that knows a SKU but not the editor's product wording cannot blank it.
 */
export async function saveOffer(articleId: string, input: OfferInput): Promise<ProductOffer> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ProductOffer>(
      `INSERT INTO product_offers
         (article_id, go_slug, product_name, url, price, currency, price_observed_on,
          preorder, release_date, merchant, source, entered_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (article_id, go_slug) DO UPDATE SET
         product_name      = COALESCE(NULLIF(excluded.product_name, ''), product_offers.product_name),
         url               = excluded.url,
         price             = excluded.price,
         currency          = excluded.currency,
         price_observed_on = excluded.price_observed_on,
         preorder          = excluded.preorder,
         release_date      = excluded.release_date,
         merchant          = excluded.merchant,
         source            = excluded.source,
         entered_by        = excluded.entered_by,
         note              = excluded.note,
         updated_at        = now()
       RETURNING ${OFFER_COLUMNS}`,
      [
        articleId,
        input.goSlug,
        input.productName,
        input.url,
        input.price,
        input.currency,
        input.priceObservedOn,
        input.preorder,
        input.releaseDate,
        input.merchant,
        input.source,
        input.enteredBy,
        input.note ?? null,
      ],
    );
    const offer = rows[0];
    await client.query(
      `INSERT INTO product_offer_revisions
         (offer_id, article_id, go_slug, url, price, currency, price_observed_on,
          preorder, release_date, merchant, source, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        offer.id,
        articleId,
        offer.go_slug,
        offer.url,
        offer.price,
        offer.currency,
        offer.price_observed_on,
        offer.preorder,
        offer.release_date,
        offer.merchant,
        offer.source,
        offer.entered_by,
      ],
    );
    await client.query('COMMIT');
    return offer;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Detach the current offer. The revisions stay: what a reader was shown, and
 * on whose authority, outlives the record itself.
 */
export async function deleteOffer(articleId: string, goSlug: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    'DELETE FROM product_offers WHERE article_id = $1 AND go_slug = $2 RETURNING id',
    [articleId, goSlug],
  );
  return rows.length > 0;
}
