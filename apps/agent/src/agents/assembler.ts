// Assembler — turns the approved draft into the exact D1 payload: validated
// frontmatter JSON + affiliate_links rows for every /go/ slug in the body.
// Affiliate destinations are built 100% deterministically from the dossier —
// no LLM touches a URL. Each row is region-aware: a liveness-verified ASIN for
// the marketplace it was captured on, plus a search term the /go/ resolver
// uses for every other region (search-results pages never 404).
import {
  amazonSearchUrl,
  estimateReadTime,
  goSlugsIn,
  pickCover,
  validateArticle,
} from '../content/contract.js';
import { productSearchTerm, verifyAmazonProductUrl } from '../tools/amazon.js';
import type { AffiliateLinkRow, ArticleRow } from '../pipeline/types.js';

export interface AssembledArticle {
  frontmatter: Record<string, unknown>;
  affiliateLinks: AffiliateLinkRow[];
  /** Body after stripping /go/ links that had no resolvable destination. */
  body: string;
  droppedSlugs: string[];
}

export async function runAssembler(article: ArticleRow): Promise<AssembledArticle> {
  const brief = article.outline!;
  let body = article.draft_md!;
  const slugsInBody = goSlugsIn(body);
  const products = article.research?.products ?? [];
  const today = new Date().toISOString().slice(0, 10);

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

  // One affiliate row per /go/ slug in the body, straight from the dossier.
  const bySlug = new Map<string, AffiliateLinkRow>();
  for (const slug of slugsInBody) {
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
  const finalLinks = [...bySlug.values()];

  // A /go/ slug with no dossier product would fail the site build. Rather than
  // failing the article, strip those links and keep the product as plain text.
  const droppedSlugs = slugsInBody.filter((slug) => !bySlug.has(slug));
  for (const slug of droppedSlugs) {
    body = body
      .replace(new RegExp(`\\[([^\\]]*)\\]\\(/go/${slug}\\)`, 'g'), '$1')
      .replace(new RegExp(`/go/${slug}`, 'g'), '');
  }
  frontmatter.readTime = estimateReadTime(body);

  // Anything left is a genuine contract violation (schema, raw merchant URL,
  // non-approved merchant destination).
  const problems = validateArticle(body, frontmatter, finalLinks);
  if (problems.length > 0) {
    throw new Error(`assembly validation failed:\n- ${problems.join('\n- ')}`);
  }
  return { frontmatter, affiliateLinks: finalLinks, body, droppedSlugs };
}
