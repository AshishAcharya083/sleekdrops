// Frontmatter assembly, focused on the hero image: the assembler is the one
// place that decides which image a published article ends up with, and it runs
// again on every revision — so this is what keeps an operator's own image from
// being quietly dropped by the next pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssembler } from './assembler.js';
import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

const brief: ContentBrief = {
  seoTitle: 'Best budget air fryers (2026)',
  dek: 'The three worth buying, and the one to skip.',
  slug: 'best-budget-air-fryers',
  author: 'mira',
  kind: 'buying guide',
  searchIntent: 'commercial',
  primaryKeyword: 'budget air fryer',
  secondaryKeywords: [],
  tags: ['air fryers'],
  wordCountTarget: 1500,
  sections: [],
  faq: [],
};

/** An article that has cleared seo_review — no products, so no /go/ links. */
function article(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: '0d1c8f5a-3c2b-4a5e-9f10-2b3c4d5e6f70',
    topic_id: null,
    title: brief.seoTitle,
    slug: brief.slug,
    category: 'Home',
    post_type: 'guide',
    stage: 'assemble',
    status: 'running',
    revision_round: 0,
    research: null,
    outline: brief,
    draft_md: '## Our pick\n\nThe Ninja is the one to buy.',
    seo_review: null,
    frontmatter: null,
    affiliate_links: null,
    hero_image_url: null,
    hero_alt: null,
    feedback: null,
    error: null,
    published_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

test('an operator-dropped hero image lands in frontmatter with its alt text', async () => {
  const { frontmatter } = await runAssembler(
    article({
      hero_image_url: 'https://storage.googleapis.com/sleekdrops-images/heroes/uploads/article-x-ab12cd34.jpg',
      hero_alt: 'Ninja air fryer on a kitchen bench',
    }),
  );

  assert.equal(
    frontmatter.heroImage,
    'https://storage.googleapis.com/sleekdrops-images/heroes/uploads/article-x-ab12cd34.jpg',
  );
  assert.equal(frontmatter.heroAlt, 'Ninja air fryer on a kitchen bench');
});

test('it outranks an image the agent found on an earlier pass', async () => {
  const { frontmatter } = await runAssembler(
    article({
      hero_image_url: 'https://storage.googleapis.com/bucket/mine.jpg',
      hero_alt: 'Mine',
      frontmatter: { heroImage: 'https://storage.googleapis.com/bucket/agent-found.jpg', heroAlt: 'Theirs' },
    }),
  );

  assert.equal(frontmatter.heroImage, 'https://storage.googleapis.com/bucket/mine.jpg');
  assert.equal(frontmatter.heroAlt, 'Mine');
});

test('without one, an image the agent already found is carried through re-assembly', async () => {
  const { frontmatter } = await runAssembler(
    article({ frontmatter: { heroImage: 'https://storage.googleapis.com/bucket/agent-found.jpg', heroAlt: 'Theirs' } }),
  );

  assert.equal(frontmatter.heroImage, 'https://storage.googleapis.com/bucket/agent-found.jpg');
  assert.equal(frontmatter.heroAlt, 'Theirs');
});

test('an operator image with no alt text leaves heroAlt off entirely', async () => {
  // Not null, not "": the website's frontmatter schema takes an optional
  // string, and a null would fail the site build.
  const { frontmatter } = await runAssembler(
    article({ hero_image_url: 'https://storage.googleapis.com/bucket/mine.jpg', hero_alt: null }),
  );

  assert.equal(frontmatter.heroImage, 'https://storage.googleapis.com/bucket/mine.jpg');
  assert.equal('heroAlt' in frontmatter, false);
});

test('no hero image at all still assembles — the site renders its cover fill', async () => {
  const { frontmatter } = await runAssembler(article());

  assert.equal('heroImage' in frontmatter, false);
  assert.match(String(frontmatter.cover), /^fill-[1-8]$/);
});

// ── The monetisation gate ────────────────────────────────────────────────────
// A "which should I buy" piece that ships with nothing to click earns nothing,
// and post_type does not catch it: a plain `article` is allowed to carry no
// products (a trend piece has nothing to link), so the only signal is the
// intent the keyword strategist read off the SERP. Production produced exactly
// this shape — post_type "article", intent "Commercial Investigation", a
// dossier with no products at all.

const plan = (intent: string) => ({ intent, primaryKeyword: 'k', wordCountTarget: 1500 }) as never;

const oneProduct = {
  summary: 's',
  facts: [],
  products: [
    { name: 'Ninja Air Fryer', brand: 'Ninja', approxPrice: 'A$199',
      amazonUrl: null, goSlug: 'ninja-air-fryer', notes: '' },
  ],
  keywords: { primary: 'air fryer', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
} as never;

test('a commercial piece whose draft linked nothing is refused', async () => {
  await assert.rejects(
    runAssembler(
      article({
        post_type: 'article',
        research: oneProduct,
        keyword_plan: plan('Commercial Investigation'),
        draft_md: '## Our pick\n\nThe Ninja is the one to buy, but here is no link.',
      }),
    ),
    /no affiliate links for a Commercial Investigation piece/,
  );
});

test('a transactional piece is held to the same bar', async () => {
  await assert.rejects(
    runAssembler(
      article({ research: oneProduct, keyword_plan: plan('Transactional'), draft_md: '## Pick\n\nBuy it.' }),
    ),
    /no affiliate links/,
  );
});

test('an informational piece may legitimately have no links', async () => {
  // A trend or explainer piece has nothing to sell. Gating on post_type alone
  // would either block this or wave the commercial case through.
  const { affiliateLinks } = await runAssembler(
    article({ post_type: 'article', research: oneProduct, keyword_plan: plan('Informational'),
              draft_md: '## What changed\n\nFoldables got cheaper.' }),
  );
  assert.deepEqual(affiliateLinks, []);
});

test('a commercial piece that did link its product passes', async () => {
  const { affiliateLinks } = await runAssembler(
    article({
      research: oneProduct,
      keyword_plan: plan('Commercial Investigation'),
      draft_md: '## Our pick\n\n[Ninja Air Fryer](/go/ninja-air-fryer) is the one to buy.',
    }),
  );
  assert.equal(affiliateLinks.length, 1);
  assert.equal(affiliateLinks[0].slug, 'ninja-air-fryer');
});

test('an article with no keyword plan is not gated', async () => {
  // Rows queued before the keyword stage existed have no intent to judge.
  const { affiliateLinks } = await runAssembler(article({ research: oneProduct, keyword_plan: null }));
  assert.deepEqual(affiliateLinks, []);
});
