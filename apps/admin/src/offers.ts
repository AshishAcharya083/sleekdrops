/**
 * The offer editor's rules, kept out of the component.
 *
 * Everything here is also enforced by the API (apps/agent/src/content/offers.ts
 * is the authority). This copy exists so the drawer can say which field is
 * wrong while the operator is still typing, and so the live preview can show
 * the exact sentence a reader would get - including the one that matters most,
 * the dated RRP, which is the difference between quoting a price and
 * misstating it.
 */

export type OfferSource = 'editor' | 'feed' | 'api';

/** ISO 4217 codes the drawer offers. AUD is the home market. */
export const OFFER_CURRENCIES = ['AUD', 'NZD', 'USD', 'GBP', 'EUR'] as const;

const CURRENCY_PREFIX: Record<string, string> = {
  AUD: 'A$',
  NZD: 'NZ$',
  USD: 'US$',
  GBP: '£',
  EUR: '€',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What the operator has typed, before anything is saved. */
export interface OfferDraft {
  productName: string;
  url: string;
  price: string;
  currency: string;
  priceObservedOn: string;
  preorder: boolean;
  releaseDate: string;
  merchant: string;
}

export type OfferField = 'url' | 'price' | 'priceObservedOn' | 'releaseDate';

export type OfferErrors = Partial<Record<OfferField, string>>;

/** A price as the reader sees it: "A$2,899", "US$1,199.50". */
export function formatOfferPrice(price: string | number | null, currency: string): string | null {
  if (price === null || price === '') return null;
  const value = typeof price === 'number' ? price : Number(price);
  if (!Number.isFinite(value)) return null;
  const digits = value % 1 === 0 ? 0 : 2;
  const amount = value.toLocaleString('en-AU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const prefix = CURRENCY_PREFIX[currency.toUpperCase()];
  return prefix ? `${prefix}${amount}` : `${currency.toUpperCase()} ${amount}`;
}

/**
 * "September 18, 2026" — the form of the date a reader is shown.
 *
 * en-US, not en-AU, because this screen exists to show the site's own words:
 * the page prints its dates through `formatLong` in apps/web/src/lib/format.ts,
 * and a preview that says "18 September 2026" is previewing a sentence the
 * reader never gets.
 */
export function formatOfferDate(iso: string | null): string {
  if (!iso || !ISO_DATE.test(iso)) return '';
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Every field that is wrong, not only the first: the footer counts them, so a
 * draft with two problems has to report two.
 */
export function validateOfferDraft(draft: OfferDraft, today: string): OfferErrors {
  const errors: OfferErrors = {};

  const url = draft.url.trim();
  if (!url) {
    errors.url = 'An affiliate URL is required — it is the whole point of the record.';
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed) errors.url = 'That is not a full URL. Paste the whole thing, starting https://';
    else if (parsed.protocol !== 'https:') errors.url = 'The URL must be https.';
    else if (parsed.searchParams.has('tag')) {
      errors.url =
        'Drop the ?tag= Associates credential — the redirect adds the right tag per marketplace.';
    }
  }

  const price = draft.price.trim();
  if (price !== '') {
    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) errors.price = 'A price is a number, or leave it empty.';
    else if (!draft.priceObservedOn) {
      errors.priceObservedOn =
        'A price needs the day it was seen — that date is what the reader is shown.';
    }
  } else if (draft.preorder) {
    // The release date and the charge-on-dispatch line ride on the offer the
    // price puts on the page: with no figure the page carries the link and
    // none of the pre-order treatment.
    errors.price =
      'A pre-order needs the price it is offered at: without a figure the page carries no ' +
      'pre-order notice at all.';
  }
  if (draft.priceObservedOn && !ISO_DATE.test(draft.priceObservedOn)) {
    errors.priceObservedOn = 'Use a date (YYYY-MM-DD).';
  } else if (draft.priceObservedOn && draft.priceObservedOn > today) {
    errors.priceObservedOn = 'A price cannot have been observed in the future.';
  }

  if (draft.preorder && !draft.releaseDate) {
    errors.releaseDate = 'A pre-order needs its release date — the reader is charged on dispatch.';
  } else if (draft.releaseDate && !ISO_DATE.test(draft.releaseDate)) {
    errors.releaseDate = 'Use a date (YYYY-MM-DD).';
  }

  return errors;
}

export function countErrors(errors: OfferErrors): number {
  return Object.keys(errors).length;
}

/** The request body PUT /api/articles/:id/offers/:slug takes. */
export interface OfferPayload {
  productName: string;
  url: string;
  price: string | null;
  currency: string;
  priceObservedOn: string | null;
  preorder: boolean;
  releaseDate: string | null;
  merchant: string | null;
}

export function offerPayload(draft: OfferDraft): OfferPayload {
  return {
    productName: draft.productName.trim(),
    url: draft.url.trim(),
    price: draft.price.trim() === '' ? null : draft.price.trim(),
    currency: draft.currency,
    priceObservedOn: draft.priceObservedOn || null,
    preorder: draft.preorder,
    releaseDate: draft.preorder ? draft.releaseDate || null : null,
    merchant: draft.merchant.trim() || null,
  };
}

/** What the reader would be shown for this draft. */
export interface OfferPreview {
  /** A pre-order gets the dark callout; everything else gets the strip. */
  preorder: boolean;
  /** True when the figure is quoted as a dated RRP rather than as live. */
  dated: boolean;
  priceLabel: string | null;
  stamp: string | null;
  releaseNote: string | null;
  checkLabel: string;
  /** The label on the offer button itself. */
  ctaLabel: string;
  /** Why the price is dated, in the words the strip prints. */
  datedReason: string | null;
}

/**
 * The reader treatment for a draft, mirroring apps/web/src/lib/offers.ts.
 *
 * A hand-entered price is always dated: nothing is polling it, so "as at" is
 * the only true thing the page can say about how current it is. A fed one is
 * dated once its observation has aged out, which the coverage row already
 * carries as `stale`.
 */
export function offerPreview(
  draft: OfferDraft,
  source: OfferSource = 'editor',
  stale = false,
): OfferPreview {
  const price = formatOfferPrice(draft.price.trim() === '' ? null : draft.price, draft.currency);
  const stampDate = formatOfferDate(draft.priceObservedOn || null);
  // A fed price carries its own staleness (the API works it out from the day it
  // was observed); a typed one is dated whatever the calendar says.
  const dated = source === 'editor' || stale;
  const release = formatOfferDate(draft.releaseDate || null);
  return {
    preorder: draft.preorder,
    dated,
    priceLabel: price ? (dated ? `RRP ${price}` : price) : null,
    stamp: dated && price && stampDate ? `as at ${stampDate}` : null,
    releaseNote: draft.preorder
      ? release
        ? `Ships ${release} — you are charged on dispatch, not today`
        : 'Pre-order — you are charged on dispatch, not today'
      : null,
    checkLabel: draft.merchant.trim()
      ? `Check current price at ${draft.merchant.trim()}`
      : 'Check current price',
    ctaLabel: draft.merchant.trim() ? `View at ${draft.merchant.trim()}` : 'View offer',
    datedReason: price && dated
      ? source === 'editor'
        ? "manufacturer's RRP, not a live price"
        : 'last fed price, not refreshed since'
      : null,
  };
}
