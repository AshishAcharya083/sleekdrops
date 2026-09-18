// Assembler — turns the approved draft into the exact D1 payload: validated
// frontmatter JSON + affiliate_links rows for every /go/ slug in the body.
// Affiliate destinations are built 100% deterministically from the dossier —
// no LLM touches a URL. Each row is region-aware: a liveness-verified ASIN for
// the marketplace it was captured on, plus a search term the /go/ resolver
// uses for every other region (search-results pages never 404).
//
// A slug the dossier cannot account for is healed out of the draft rather than
// deleted: the words the writer put on the link - or the slug itself, which is
// a product name kebab-cased - are that product's name, and a name is the
// whole input a search destination needs.
//
// Ahead of both sits an offer record an editor attached (content/offers.ts).
// On announcement day the SKU is in no feed and cannot be polled through the
// Product Advertising API, so a hand-attached destination is the only one that
// exists - and its price is the only one the page can quote, which it does as
// a dated RRP rather than as a live figure.
import {
  amazonSearchUrl,
  estimateReadTime,
  goLinkSearchTerms,
  goSlugsIn,
  HOME_CURRENCY,
  MONETISED_INTENTS,
  pickCover,
  validateArticle,
} from '../content/contract.js';
import { offerLinkRow, pickOfferFrom } from '../content/offers.js';
import { articleSources, stripUnresolvedCitations } from '../content/sources.js';
import { productSearchTerm, verifyAmazonProductUrl } from '../tools/amazon.js';
import type { AffiliateLinkRow, ArticleRow, ProductOffer } from '../pipeline/types.js';

export interface AssembledArticle {
  frontmatter: Record<string, unknown>;
  affiliateLinks: AffiliateLinkRow[];
  /** Body after stripping the /go/ links that could not be healed either. */
  body: string;
  /** Slugs whose destination came from an attached offer record. */
  offerSlugs: string[];
  /** Slugs linked to an Amazon search built from the draft's own words. */
  healedSlugs: string[];
  droppedSlugs: string[];
}

function uniqueEntities(entities: string[]): string[] {
  const seen = new Set<string>();
  for (const entity of entities) {
    const name = entity.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

export async function runAssembler(
  article: ArticleRow,
  offers: ProductOffer[] = [],
): Promise<AssembledArticle> {
  const brief = article.outline!;
  let body = article.draft_md!;
  const slugsInBody = goSlugsIn(body);
  const products = article.research?.products ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const offerBySlug = new Map(offers.map((offer) => [offer.go_slug, offer]));

  // The deterministic parts never go through the LLM. A re-assembly (e.g. the
  // admin-feedback loop) keeps the original pubDate and any hero image already
  // found, and stamps updatedDate instead.
  const prior = article.frontmatter ?? {};
  const pubDate = typeof prior.pubDate === 'string' ? prior.pubDate : today;
  const frontmatter: Record<string, unknown> = {
    title: brief.seoTitle,
    dek: brief.dek,
    category: article.category,
    postType: article.post_type,
    kind: brief.kind,
    author: brief.author,
    tags: brief.tags,
    pubDate,
    ...(pubDate !== today ? { updatedDate: today } : {}),
    // Stamped on every pass, including a re-assembly that leaves pubDate
    // alone. It is the date the piece was last rebuilt from its research and
    // checked against its sources - before the editor's sign-off at the
    // approval gate - which is a different promise from when it first went up,
    // and the one the article's review stamp makes.
    lastReviewed: today,
    readTime: estimateReadTime(body),
    cover: pickCover(brief.slug),
    featured: false,
    draft: false,
  };
  // An operator-dropped hero image outranks whatever the image agent found on
  // an earlier pass — that's the whole point of dropping one. Stamping it here
  // (not only in the image stage) is what lets an image attached at brief time
  // survive every re-assembly.
  const heroImage =
    article.hero_image_url ?? (typeof prior.heroImage === 'string' ? prior.heroImage : null);
  const heroAlt = article.hero_image_url
    ? article.hero_alt
    : typeof prior.heroAlt === 'string'
      ? prior.heroAlt
      : null;
  if (heroImage) {
    frontmatter.heroImage = heroImage;
    if (heroAlt) frontmatter.heroAlt = heroAlt;
  }

  // The resolution order, in the order it resolves. An offer an editor
  // attached outranks everything the pipeline can build for itself: it is the
  // only destination that can exist on announcement day, when the SKU is in no
  // feed and cannot be polled through the Product Advertising API. Then a
  // liveness-verified ASIN, then the search link healed out of the draft.
  const bySlug = new Map<string, AffiliateLinkRow>();
  const offerSlugs: string[] = [];
  for (const slug of slugsInBody) {
    const offer = offerBySlug.get(slug);
    if (!offer) continue;
    bySlug.set(slug, offerLinkRow(offer, brief.slug));
    offerSlugs.push(slug);
  }

  // One affiliate row per remaining /go/ slug in the body, from the dossier.
  for (const slug of slugsInBody) {
    if (bySlug.has(slug)) continue;
    const product = products.find((p) => p.goSlug === slug);
    if (!product) continue; // no dossier product behind this slug → stripped below

    const search = productSearchTerm(product);
    // Only a liveness-probed ASIN ships, and only for its own marketplace.
    const verified = product.amazonUrl ? await verifyAmazonProductUrl(product.amazonUrl) : null;

    bySlug.set(slug, {
      slug,
      // Safety-net destination (used only if the resolver can't build one):
      // home-market search results — always a live page.
      default_url: amazonSearchUrl(search),
      regions_json: {
        network: 'amazon',
        search,
        ...(verified ? { asins: { [verified.region]: verified.asin } } : {}),
      },
      note: `${product.name} — ${verified ? `ASIN ${verified.asin} (${verified.region}, verified ${today})` : 'search link (no verified ASIN)'}, used by ${brief.slug}`,
    });
  }

  // A /go/ slug with no dossier product behind it still names a real product:
  // the words on the link - or failing those, the slug itself, which is a
  // product name kebab-cased - are that name, and `amazonSearchUrl` asks for
  // nothing else. So the link is rebuilt from the body rather than deleted -
  // stripping it destroys the evidence of what the reader was promised, and
  // the monetisation gate below then fails the piece on its absence.
  //
  // The destination class is the same one every resolved row already carries
  // as its `default_url` safety net, so a healed link needs no disclosure the
  // page does not already make.
  const healable = goLinkSearchTerms(body);
  const healedSlugs: string[] = [];
  for (const slug of slugsInBody) {
    if (bySlug.has(slug)) continue;
    const named = healable.get(slug);
    if (!named) continue; // the link names no product → stripped below
    const search = productSearchTerm({ name: named.term });
    bySlug.set(slug, {
      slug,
      default_url: amazonSearchUrl(search),
      regions_json: { network: 'amazon', search },
      // Never allowed to displace another article's row for the same slug:
      // this is a guess rebuilt from one draft, and the slug map is site-wide.
      healed: true,
      note: `${search} - healed from ${named.source}, no dossier product behind it, used by ${brief.slug}`,
    });
    healedSlugs.push(slug);
  }
  const finalLinks = [...bySlug.values()];

  // What is left names nothing to search for, and a /go/ slug with no row
  // would fail the site build. Rather than failing the article, strip those
  // links and keep the sentence as plain text.
  const droppedSlugs = slugsInBody.filter((slug) => !bySlug.has(slug));
  for (const slug of droppedSlugs) {
    body = body
      .replace(new RegExp(`\\[([^\\]]*)\\]\\(/go/${slug}\\)`, 'g'), '$1')
      .replace(new RegExp(`/go/${slug}`, 'g'), '');
  }

  // The sources the page shows, and the markers in the body that point at
  // them. A marker numbered past the end of the list has nothing to link to,
  // so it goes the same way an unresolvable /go/ link does — the sentence
  // survives, the broken reference does not.
  const sources = articleSources(article.research?.facts ?? []);
  body = stripUnresolvedCitations(body, sources.length);
  frontmatter.readTime = estimateReadTime(body);

  // Structured-data inputs for the site's JSON-LD graph. `picks` is keyed off
  // the resolved affiliate rows, not the raw body, so every Offer URL the site
  // emits has a live /go/ destination behind it.
  const entities = uniqueEntities(article.keyword_plan?.entities ?? []);
  const picks = [...bySlug.keys()].flatMap((slug) => {
    const product = products.find((p) => p.goSlug === slug);
    const offer = offerBySlug.get(slug);
    // An attached offer names its own product, so a launch-window SKU the
    // dossier never carried is still a pick - which is the point: it is the
    // one the reader most needs the release date and the price stamp for.
    const name = (product?.name ?? offer?.product_name ?? '').trim();
    // A nameless product is a broken dossier row, not a pick. Skipping it keeps
    // the article publishable — the affiliate link behind it still works.
    if (!name) return [];
    const brand = product?.brand?.trim();
    // The offer's figure is a price somebody actually saw on a stated day; the
    // dossier's is an approximation from the research. The dated one wins, and
    // rides with the stamp that says what it is.
    const pickOffer = offer ? pickOfferFrom(offer, today) : null;
    const price = pickOffer?.price ?? product?.approxPrice?.trim();
    return [
      {
        name,
        ...(brand ? { brand } : {}),
        ...(price ? { price } : {}),
        goSlug: slug,
        ...(pickOffer ? { offer: pickOffer } : {}),
      },
    ];
  });
  if (sources.length > 0) frontmatter.sources = sources;
  if (entities.length > 0) frontmatter.entities = entities;
  if (picks.length > 0) frontmatter.picks = picks;
  frontmatter.currency = HOME_CURRENCY;

  // Anything left is a genuine contract violation (schema, raw merchant URL,
  // non-approved merchant destination).
  const problems = validateArticle(body, frontmatter, finalLinks);
  if (problems.length > 0) {
    throw new Error(`assembly validation failed:\n- ${problems.join('\n- ')}`);
  }
  // Last line, and only after healing has had its turn: a commercial piece
  // with nothing clickable on it either linked nothing at all or named nothing
  // a reader could be sent to. This is not a judgement about revenue - a
  // launch-window piece settles its commission 6-12+ weeks after the traffic,
  // so nobody can tell at publish time what a page earns. It is the page
  // failing to do what a "which should I buy" piece exists to do.
  const intent = article.keyword_plan?.intent;
  if (finalLinks.length === 0 && intent && MONETISED_INTENTS.has(intent)) {
    throw new Error(
      `no affiliate links for a ${intent} piece: the dossier carried ${products.length} product(s), ` +
        `the draft linked ${slugsInBody.length} /go/ slug(s), and healing recovered ` +
        `${healedSlugs.length} of ${slugsInBody.length}` +
        `${droppedSlugs.length > 0 ? ` (nothing nameable in: ${droppedSlugs.join(', ')})` : ''}. ` +
        `There is nothing on the page for a reader to click.`,
    );
  }

  return { frontmatter, affiliateLinks: finalLinks, body, offerSlugs, healedSlugs, droppedSlugs };
}
