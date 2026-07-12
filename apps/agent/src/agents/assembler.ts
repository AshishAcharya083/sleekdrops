// Assembler — turns the approved draft into the exact D1 payload: validated
// frontmatter JSON + affiliate_links rows for every /go/ slug in the body.
// Deterministic code does the validation; the LLM only fills editorial gaps.
import { chatJson, UsageTracker } from '../llm/index.js';
import {
  estimateReadTime,
  goSlugsIn,
  pickCover,
  validateArticle,
} from '../content/contract.js';
import { SITE_CONTEXT } from './context.js';
import type { AffiliateLinkRow, ArticleRow } from '../pipeline/types.js';

export interface AssembledArticle {
  frontmatter: Record<string, unknown>;
  affiliateLinks: AffiliateLinkRow[];
  /** Body after stripping /go/ links that had no resolvable destination. */
  body: string;
  droppedSlugs: string[];
}

export async function runAssembler(
  article: ArticleRow,
  model: string,
  tracker: UsageTracker,
): Promise<AssembledArticle> {
  const brief = article.outline!;
  let body = article.draft_md!;
  const slugsInBody = goSlugsIn(body);
  const products = article.research?.products ?? [];
  const today = new Date().toISOString().slice(0, 10);

  // The deterministic parts never go through the LLM.
  const frontmatter: Record<string, unknown> = {
    title: brief.seoTitle,
    dek: brief.dek,
    category: article.category,
    postType: article.post_type,
    kind: brief.kind,
    author: brief.author,
    tags: brief.tags,
    pubDate: today,
    readTime: estimateReadTime(body),
    cover: pickCover(brief.slug),
    featured: false,
    draft: false,
  };

  // LLM maps each /go/ slug in the body to its affiliate destination using
  // the dossier's real Amazon URLs.
  let links: AffiliateLinkRow[] = [];
  if (slugsInBody.length > 0) {
    const mapped = await chatJson<{ links: AffiliateLinkRow[] }>(
      {
        model,
        system: SITE_CONTEXT,
        temperature: 0.1,
        prompt: `Map each affiliate slug used in an article body to its destination URL.

Slugs used in the body: ${slugsInBody.join(', ')}

Known products (ONLY legitimate URL source — amazonUrl values are real):
${JSON.stringify(products, null, 2)}

Rules:
- One row per slug that appears in the body.
- default_url: the product's amazonUrl from the list above. If a slug has no
  matching product with a real amazonUrl, use "MISSING" so it can be caught.
- note: "<product name>, Amazon Australia, used by ${brief.slug}".

Return JSON {"links": [{"slug": string, "default_url": string, "note": string}]}`,
      },
      tracker,
    );
    links = mapped.links ?? [];
  }

  // Fill gaps deterministically from the dossier before failing anything.
  const bySlug = new Map(links.map((l) => [l.slug, l]));
  for (const slug of slugsInBody) {
    const existing = bySlug.get(slug);
    if (existing && existing.default_url !== 'MISSING') continue;
    const product = products.find((p) => p.goSlug === slug && p.amazonUrl);
    if (product) {
      bySlug.set(slug, {
        slug,
        default_url: product.amazonUrl!,
        note: `${product.name}, Amazon Australia, used by ${brief.slug}`,
      });
    } else {
      bySlug.delete(slug);
    }
  }
  const finalLinks = [...bySlug.values()].filter((l) => slugsInBody.includes(l.slug));

  // A /go/ slug with no resolvable URL would fail the site build. Rather than
  // failing the article, strip those links and keep the product as plain text.
  const resolvable = new Set(finalLinks.map((l) => l.slug));
  const droppedSlugs = slugsInBody.filter((slug) => !resolvable.has(slug));
  for (const slug of droppedSlugs) {
    body = body
      .replace(new RegExp(`\\[([^\\]]*)\\]\\(/go/${slug}\\)`, 'g'), '$1')
      .replace(new RegExp(`/go/${slug}`, 'g'), '');
  }
  frontmatter.readTime = estimateReadTime(body);

  // Anything left is a genuine contract violation (schema, raw merchant URL).
  const problems = validateArticle(body, frontmatter, finalLinks);
  if (problems.length > 0) {
    throw new Error(`assembly validation failed:\n- ${problems.join('\n- ')}`);
  }
  return { frontmatter, affiliateLinks: finalLinks, body, droppedSlugs };
}
