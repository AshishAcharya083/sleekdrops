// Per-offer records: what an editor may attach to a product, what the reader
// is then told, and how a card's launch coverage reads.
//
// None of this touches the database or the network. The rules are here, in one
// place, because three surfaces have to agree on them: the admin API that
// validates a save, the assembler that turns a record into an affiliate row and
// a frontmatter pick, and the panel that shows an operator what is covered.
//
// The premise, from the launch-window finding: a link is available on
// announcement day (a deep link works off any live advertiser URL) but the
// DATA is not - feeds only carry SKUs the merchant has published, and the
// Product Advertising API is gated behind 3 qualifying sales in 180 days. So a
// price here is something a person saw on a page on a given day, and it is
// presented as exactly that: an RRP with the day attached, never as a live
// price.
import type {
  AffiliateLinkRow,
  OfferInput,
  OfferSource,
  ProductOffer,
  ResearchDossier,
} from '../pipeline/types.js';
import { amazonSearchUrl, goSlugsIn, HOME_CURRENCY, parseAmazonUrl } from './contract.js';

/**
 * How long an automatically-sourced price stays presentable as current.
 *
 * A feed row is only as good as its last refresh, so past this it is shown the
 * same way a hand-entered price always is: dated, labelled RRP, with a link to
 * check the live figure. An editor-entered price is never "fresh" in this
 * sense - nobody is polling it - so it carries the stamp from the day it was
 * typed.
 */
export const STALE_PRICE_DAYS = 7;

/** ISO 4217 codes the panel offers. The home market is AUD (see HOME_CURRENCY). */
export const OFFER_CURRENCIES = ['AUD', 'NZD', 'USD', 'GBP', 'EUR'] as const;

/** What each currency looks like to a reader in an Australian publication. */
const CURRENCY_PREFIX: Record<string, string> = {
  AUD: 'A$',
  NZD: 'NZ$',
  USD: 'US$',
  GBP: '£',
  EUR: '€',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GO_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest URL we will store - well past any real deep link. */
const MAX_URL_CHARS = 2000;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

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

/** Whole days between two ISO days, or null when either is unreadable. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Whether a price has to be shown as a dated RRP rather than as a live figure.
 *
 * True for every hand-entered price, and for a fed one whose last observation
 * has aged past STALE_PRICE_DAYS. An undated price is stale by definition:
 * there is nothing to say it is current.
 */
export function offerPriceIsStale(
  offer: Pick<ProductOffer, 'source' | 'price_observed_on'>,
  today: string,
): boolean {
  if (offer.source === 'editor') return true;
  if (!offer.price_observed_on) return true;
  const age = daysBetween(offer.price_observed_on, today);
  return age === null || age > STALE_PRICE_DAYS;
}

/**
 * The offer object that rides into a frontmatter pick, or null when the record
 * carries no price. Only the /go/ hop reaches the page, never the merchant URL
 * itself - a raw merchant link in published content is a contract violation.
 */
export interface PickOffer {
  price: string;
  currency: string;
  /** The day the price was observed (YYYY-MM-DD) - what the stamp shows. */
  asAt: string;
  source: OfferSource;
  /** True when the price must be shown as a dated RRP, not as a live price. */
  stale: boolean;
  merchant?: string;
  preorder?: boolean;
  /** When a pre-order ships, and therefore when the reader is charged. */
  releaseDate?: string;
}

export function pickOfferFrom(offer: ProductOffer, today: string): PickOffer | null {
  const price = formatOfferPrice(offer.price, offer.currency);
  const asAt = offer.price_observed_on;
  if (!price || !asAt) return null;
  return {
    price,
    currency: offer.currency.toUpperCase(),
    asAt,
    source: offer.source,
    stale: offerPriceIsStale(offer, today),
    ...(offer.merchant ? { merchant: offer.merchant } : {}),
    ...(offer.preorder ? { preorder: true } : {}),
    ...(offer.preorder && offer.release_date ? { releaseDate: offer.release_date } : {}),
  };
}

/** The provenance note an offer-backed affiliate row carries. */
export function offerLinkNote(offer: ProductOffer, articleSlug: string): string {
  const price = formatOfferPrice(offer.price, offer.currency);
  const priced = price && offer.price_observed_on ? `${price} as at ${offer.price_observed_on}` : 'no price';
  const kind = offer.source === 'editor' ? 'editor-attached offer' : `${offer.source} offer`;
  return `${offer.product_name || offer.go_slug} — ${kind}, ${priced}${
    offer.preorder ? ', pre-order' : ''
  }, used by ${articleSlug}`;
}

/**
 * The affiliate row an offer record resolves to.
 *
 * An Amazon product URL is turned back into the ASIN it names rather than
 * stored as typed. Associates tags are per-marketplace credentials the
 * redirect resolver owns, so a literal amazon.com.au link would go out
 * untagged - a click we earn nothing on, which is the one failure this whole
 * feature exists to remove. The ASIN is filed for the marketplace it was
 * captured on (an ASIN routinely 404s on another storefront) with a search
 * term behind it for every other region; the ASIN is not liveness-probed
 * because a person just read the page it came off.
 *
 * Anywhere else, `regions_json` stays empty: the destination is one absolute
 * URL a human chose, so the resolver's `direct` builder hands it back as-is
 * and every region gets it - the record has no per-market equivalent to offer,
 * and the home market is the one this publication sells into. `manual` is what
 * lets the contract check accept a destination outside the Amazon marketplaces
 * the pipeline builds for itself.
 */
export function offerLinkRow(offer: ProductOffer, articleSlug: string): AffiliateLinkRow {
  const note = offerLinkNote(offer, articleSlug);
  const amazon = parseAmazonUrl(offer.url);
  if (amazon) {
    const search = offer.product_name.trim() || offer.go_slug.split('-').join(' ');
    return {
      slug: offer.go_slug,
      default_url: amazonSearchUrl(search),
      regions_json: { network: 'amazon', search, asins: { [amazon.region]: amazon.asin } },
      manual: true,
      note: `${note} (ASIN ${amazon.asin} on ${amazon.region})`,
    };
  }
  return {
    slug: offer.go_slug,
    default_url: offer.url,
    regions_json: null,
    manual: true,
    note,
  };
}

// ---------------------------------------------------------------------------
// Validation — the admin API's authority on what may be saved.
// ---------------------------------------------------------------------------

/**
 * An affiliate destination a human typed.
 *
 * https only (a tracked click through http is a click a network may refuse to
 * attribute), and never carrying an Amazon Associates tag: tags are
 * per-marketplace credentials owned by the redirect resolver, and one pasted
 * into a stored row is a credential in data that outlives the account it
 * belongs to.
 */
export function validateOfferUrl(raw: unknown): Validated<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'an affiliate URL is required' };
  }
  const value = raw.trim();
  if (value.length > MAX_URL_CHARS) {
    return { ok: false, error: `the affiliate URL must be under ${MAX_URL_CHARS} characters` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'the affiliate URL must be a full URL, e.g. https://…' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'the affiliate URL must be https' };
  if (url.searchParams.has('tag')) {
    return {
      ok: false,
      error:
        'drop the ?tag= Associates credential - the redirect resolver adds the right tag per marketplace',
    };
  }
  return { ok: true, value };
}

function validateDate(raw: unknown, label: string): Validated<string | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || !ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    return { ok: false, error: `${label} must be a date (YYYY-MM-DD)` };
  }
  return { ok: true, value: raw };
}

/**
 * A save from the panel (or from a future feed sync), checked the same way
 * whichever surface sent it.
 *
 * A price and the day it was observed travel together: a figure with no day
 * behind it is the thing this feature exists to stop us printing.
 */
export function validateOfferInput(raw: unknown, today: string): Validated<OfferInput> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'expected an offer object' };
  const body = raw as Record<string, unknown>;

  const slug = typeof body.goSlug === 'string' ? body.goSlug.trim() : '';
  if (!GO_SLUG.test(slug)) return { ok: false, error: 'goSlug must be a /go/ slug' };

  const url = validateOfferUrl(body.url);
  if (!url.ok) return url;

  let price: string | null = null;
  if (body.price !== undefined && body.price !== null && body.price !== '') {
    const value = Number(body.price);
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: 'the price must be a number, or left empty' };
    }
    if (value > 1_000_000_000) return { ok: false, error: 'that price is not a real price' };
    price = value.toFixed(2);
  }

  const currency =
    typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : HOME_CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'currency must be an ISO 4217 code' };

  const observed = validateDate(body.priceObservedOn, 'the date the price was observed');
  if (!observed.ok) return observed;
  if (price !== null && !observed.value) {
    return { ok: false, error: 'a price needs the date it was observed - that is what the reader is shown' };
  }
  if (observed.value && daysBetween(observed.value, today)! < 0) {
    return { ok: false, error: 'the price cannot have been observed in the future' };
  }

  const preorder = body.preorder === true;
  const release = validateDate(body.releaseDate, 'the release date');
  if (!release.ok) return release;
  if (preorder && !release.value) {
    return { ok: false, error: 'a pre-order needs its release date - the reader is charged on dispatch' };
  }

  const source: OfferSource =
    body.source === 'feed' || body.source === 'api' ? body.source : 'editor';

  return {
    ok: true,
    value: {
      goSlug: slug,
      productName: typeof body.productName === 'string' ? body.productName.trim().slice(0, 200) : '',
      url: url.value,
      price,
      currency,
      priceObservedOn: observed.value,
      preorder,
      releaseDate: preorder ? release.value : null,
      merchant:
        typeof body.merchant === 'string' && body.merchant.trim()
          ? body.merchant.trim().slice(0, 80)
          : null,
      source,
      enteredBy: source === 'editor' ? 'operator' : source,
    },
  };
}

// ---------------------------------------------------------------------------
// Coverage — which products in a card can be monetised, and how.
// ---------------------------------------------------------------------------

/**
 * How a product's destination is arrived at. The four-colour vocabulary the
 * panel renders: violet for what an editor authored, indigo for a resolved
 * ASIN, amber for a search link or a price that has gone stale, red for a
 * product with nothing behind it at all.
 */
export type OfferProvenance = 'editor' | 'resolved' | 'healed' | 'none';

export interface OfferCoverageRow {
  goSlug: string;
  productName: string;
  provenance: OfferProvenance;
  /** Short label for the chip, e.g. "Editor offer", "Resolved ASIN". */
  label: string;
  /** Where a reader lands today, or null when nothing is attached. */
  destination: string | null;
  /** How that destination was arrived at, in a sentence. */
  destinationNote: string | null;
  /** The reader-facing price, when the offer carries one. */
  price: string | null;
  /** The day that price was observed. */
  asAt: string | null;
  /** True when the price must be shown as a dated RRP rather than as live. */
  stale: boolean;
  preorder: boolean;
  releaseDate: string | null;
  /** True when the article body actually links this slug. */
  inBody: boolean;
  /**
   * True when the record has been saved but the assembled page still carries
   * the old destination or the old stamp. Attaching an offer does not rewrite
   * a page that has already been built, so the panel says so rather than
   * implying the reader is already seeing it.
   */
  pending: boolean;
  offer: ProductOffer | null;
}

export interface OfferCoverage {
  rows: OfferCoverageRow[];
  /** Products with an offer of their own: editor-attached or a resolved ASIN. */
  covered: number;
  total: number;
  counts: Record<OfferProvenance, number>;
}

/**
 * The reader-visible half of an offer, as one comparable string: the price,
 * the day it was observed and the pre-order promise. Two records with the same
 * stamp say the same thing to a reader, which is the only difference that
 * makes a rebuild worth asking for.
 */
function stampOf(offer: PickOffer | null): string {
  if (!offer) return '';
  return [offer.price, offer.asAt, offer.stale, offer.preorder ?? false, offer.releaseDate ?? '']
    .join('|');
}

/**
 * Whether the page as last assembled already says what this record says: the
 * same destination behind the link, and the same figure and promise in the
 * stamp.
 */
function onPage(
  link: AffiliateLinkRow | undefined,
  offer: ProductOffer,
  publishedStamp: string,
  today: string,
): boolean {
  if (!link) return false;
  const built = offerLinkRow(offer, '');
  return (
    link.default_url === built.default_url &&
    publishedStamp === stampOf(pickOfferFrom(offer, today))
  );
}

/** The stamp each pick in the last assembled frontmatter is carrying. */
function publishedStamps(frontmatter: Record<string, unknown> | null): Map<string, string> {
  const picks = Array.isArray(frontmatter?.picks) ? frontmatter.picks : [];
  const stamps = new Map<string, string>();
  for (const pick of picks) {
    if (typeof pick !== 'object' || pick === null) continue;
    const { goSlug, offer } = pick as { goSlug?: unknown; offer?: unknown };
    if (typeof goSlug !== 'string') continue;
    stamps.set(goSlug, stampOf((offer as PickOffer | undefined) ?? null));
  }
  return stamps;
}

const PROVENANCE_LABEL: Record<OfferProvenance, string> = {
  editor: 'Editor offer',
  resolved: 'Resolved ASIN',
  healed: 'Search link',
  none: 'No offer',
};

/**
 * Every product in a card, with the destination and price a reader would get
 * today.
 *
 * Read in the same order the assembler resolves: an attached offer record
 * first, then a verified ASIN, then the search link healed out of the draft.
 * Before the assemble stage there are no affiliate rows yet, so the dossier
 * stands in - a product carrying an Amazon product URL is on track to resolve,
 * and one carrying nothing is exactly the row an editor is here to fix.
 */
export function offerCoverage(
  article: {
    draft_md: string | null;
    research: ResearchDossier | null;
    affiliate_links: AffiliateLinkRow[] | null;
    frontmatter: Record<string, unknown> | null;
  },
  offers: ProductOffer[],
  today: string,
): OfferCoverage {
  const products = article.research?.products ?? [];
  const bodySlugs = new Set(goSlugsIn(article.draft_md ?? ''));
  const linkBySlug = new Map((article.affiliate_links ?? []).map((link) => [link.slug, link]));
  const assembled = article.affiliate_links !== null;
  const stampBySlug = publishedStamps(article.frontmatter);
  const offerBySlug = new Map(offers.map((offer) => [offer.go_slug, offer]));

  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string) => {
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  };
  for (const product of products) add(product.goSlug);
  for (const slug of bodySlugs) add(slug);
  for (const offer of offers) add(offer.go_slug);

  const rows = slugs.map((slug): OfferCoverageRow => {
    const product = products.find((p) => p.goSlug === slug);
    const offer = offerBySlug.get(slug) ?? null;
    const link = linkBySlug.get(slug);
    const name = offer?.product_name || product?.name || slug.split('-').join(' ');
    const base = {
      goSlug: slug,
      productName: name,
      inBody: bodySlugs.has(slug),
      pending: false,
      offer,
    };

    if (offer) {
      const stale = offerPriceIsStale(offer, today);
      const provenance: OfferProvenance =
        offer.source === 'editor' ? 'editor' : stale ? 'healed' : 'resolved';
      return {
        ...base,
        // A row is only pending when what the built page shows differs from
        // the record. `?? ''` rather than a strict lookup: an offer with no
        // price writes no stamp, and a pick that carries none is showing
        // exactly that.
        pending: assembled && !onPage(link, offer, stampBySlug.get(slug) ?? '', today),
        provenance,
        label: offer.source === 'editor' ? PROVENANCE_LABEL.editor : `${offer.source} offer`,
        destination: offer.url,
        destinationNote:
          offer.source === 'editor'
            ? `attached by hand${offer.merchant ? ` at ${offer.merchant}` : ''}`
            : `from the ${offer.source}${offer.merchant ? ` at ${offer.merchant}` : ''}`,
        price: formatOfferPrice(offer.price, offer.currency),
        asAt: offer.price_observed_on,
        stale,
        preorder: offer.preorder,
        releaseDate: offer.release_date,
      };
    }

    const asin = link?.regions_json?.asins ?? null;
    if (asin && Object.keys(asin).length > 0) {
      const [region, value] = Object.entries(asin)[0];
      return {
        ...base,
        provenance: 'resolved',
        label: PROVENANCE_LABEL.resolved,
        destination: link?.default_url ?? null,
        destinationNote: `ASIN ${value} verified on ${region}`,
        price: null,
        asAt: null,
        stale: false,
        preorder: false,
        releaseDate: null,
      };
    }

    if (link) {
      return {
        ...base,
        provenance: 'healed',
        label: PROVENANCE_LABEL.healed,
        destination: link.default_url,
        destinationNote: link.healed
          ? 'healed from the draft - a search, not this product'
          : 'search results - no verified ASIN',
        price: null,
        asAt: null,
        stale: false,
        preorder: false,
        releaseDate: null,
      };
    }

    const dossierAsin = product?.amazonUrl ? parseAmazonUrl(product.amazonUrl) : null;
    if (dossierAsin) {
      return {
        ...base,
        provenance: 'resolved',
        label: PROVENANCE_LABEL.resolved,
        destination: product!.amazonUrl,
        destinationNote: `ASIN ${dossierAsin.asin} from the dossier, checked at assemble`,
        price: null,
        asAt: null,
        stale: false,
        preorder: false,
        releaseDate: null,
      };
    }

    return {
      ...base,
      provenance: 'none',
      label: PROVENANCE_LABEL.none,
      destination: null,
      destinationNote: null,
      price: null,
      asAt: null,
      stale: false,
      preorder: false,
      releaseDate: null,
    };
  });

  const counts: Record<OfferProvenance, number> = { editor: 0, resolved: 0, healed: 0, none: 0 };
  for (const row of rows) counts[row.provenance] += 1;
  return { rows, counts, covered: counts.editor + counts.resolved, total: rows.length };
}
