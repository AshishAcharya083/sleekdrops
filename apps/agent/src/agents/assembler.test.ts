// Frontmatter assembly, focused on the hero image: the assembler is the one
// place that decides which image a published article ends up with, and it runs
// again on every revision — so this is what keeps an operator's own image from
// being quietly dropped by the next pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssembler } from './assembler.js';
import { citedSourceIndexes } from '../content/sources.js';
import type { ArticleRow, ContentBrief } from '../pipeline/types.js';

const brief: ContentBrief = {
  seoTitle: 'Best budget air fryers (2026)',
  dek: 'The three worth buying, and the one to skip.',
  slug: 'best-budget-air-fryers',
  author: 'desk',
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
// A "which should I buy" piece that ships with nothing to click fails at the
// one job it was commissioned to do, and post_type does not catch it: a plain
// `article` is allowed to carry no products (a trend piece has nothing to
// link), so the only signal is the intent the keyword strategist read off the
// SERP. Production produced exactly this shape — post_type "article", intent
// "Commercial Investigation", a dossier with no products at all.

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

// ── Structured-data inputs ───────────────────────────────────────────────────
// The frontmatter the site's JSON-LD graph is built from. Everything here is
// deterministic: the dossier's sources become `citation`, the keyword plan's
// entities become `about`/`mentions`, and `picks` become the ItemList — but
// only for the /go/ slugs that resolved to a live affiliate row.

const twoProducts = {
  summary: 's',
  facts: [
    { fact: 'Sticks lose suction as the filter clogs.', sourceUrl: 'https://www.choice.com.au/vacuums' },
    { fact: 'Owners report brush-bar tangles.', sourceUrl: 'https://www.productreview.com.au/shark' },
    { fact: 'Same page, second fact.', sourceUrl: 'https://www.choice.com.au/vacuums' },
    { fact: 'Unparseable source.', sourceUrl: 'not a url' },
  ],
  products: [
    { name: 'Shark Detect Pro', brand: 'Shark', approxPrice: 'A$1,199',
      amazonUrl: null, goSlug: 'shark-detect-pro', notes: '' },
    { name: 'Dyson V15 Detect', brand: 'Dyson', approxPrice: '',
      amazonUrl: null, goSlug: 'dyson-v15-detect', notes: '' },
  ],
  keywords: { primary: 'cordless stick vacuum', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
} as never;

const vacuumPlan = {
  intent: 'Commercial Investigation',
  primaryKeyword: 'best cordless stick vacuum',
  wordCountTarget: 1500,
  entities: ['Dyson', 'Shark', 'HEPA filtration', 'Dyson', ' '],
} as never;

const linkedBody =
  '## Our picks\n\n[Shark Detect Pro](/go/shark-detect-pro) is the one to buy, ' +
  'and the [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.';

test('sources, entities, picks and the currency ride through frontmatter', async () => {
  const { frontmatter } = await runAssembler(
    article({ research: twoProducts, keyword_plan: vacuumPlan, draft_md: linkedBody }),
  );

  // Deduped by URL, http(s) only, in the order the research stated them.
  assert.deepEqual(frontmatter.sources, [
    { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
    { url: 'https://www.productreview.com.au/shark', publisher: 'productreview.com.au' },
  ]);
  assert.deepEqual(frontmatter.entities, ['Dyson', 'Shark', 'HEPA filtration']);
  // Every pick carries an evidence chip, always filled: an empty badge slot
  // beside a filled one reads as a defect in the product rather than as a fact
  // about our evidence. Nothing here was measured by us, so both say so.
  assert.deepEqual(frontmatter.picks, [
    { name: 'Shark Detect Pro', brand: 'Shark', price: 'A$1,199', goSlug: 'shark-detect-pro',
      evidence: 'researched' },
    { name: 'Dyson V15 Detect', brand: 'Dyson', goSlug: 'dyson-v15-detect', evidence: 'researched' },
  ]);
  assert.equal(frontmatter.currency, 'AUD');
});

test('a source URL is stored as the parser normalised it, not as it was stated', async () => {
  // A source URL comes from search results, so it is untrusted text that ends
  // up inside the page's <script type="application/ld+json"> block. `new URL()`
  // percent-encodes the characters that could close that block early, and
  // canonicalising also collapses two spellings of one page into one citation.
  const hostile = {
    ...(twoProducts as unknown as { facts: Array<Record<string, unknown>> }),
    facts: [
      { fact: 'Breakout attempt.', sourceUrl: 'https://evil.example/a</script><script>alert(1)</script>' },
      { fact: 'Same page, other spelling.', sourceUrl: 'https://WWW.Choice.com.au/vacuums' },
      { fact: 'Same page again.', sourceUrl: 'https://www.choice.com.au/vacuums' },
      { fact: 'Not a web scheme.', sourceUrl: 'javascript:alert(1)' },
    ],
  } as never;

  const { frontmatter } = await runAssembler(
    article({ research: hostile, keyword_plan: vacuumPlan, draft_md: linkedBody }),
  );

  assert.deepEqual(frontmatter.sources, [
    {
      url: 'https://evil.example/a%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E',
      publisher: 'evil.example',
    },
    { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
  ]);
});

test('picks only cover the /go/ slugs a dossier product stands behind', async () => {
  // The draft linked a product the dossier never carried. The link itself is
  // healed from its anchor text, but there is no dossier row behind it, so it
  // must not become a pick: `picks` is what the site's ItemList is built from,
  // and it carries a brand and a price this product has neither of.
  const { frontmatter, droppedSlugs, healedSlugs } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: '## Our pick\n\n[Shark Detect Pro](/go/shark-detect-pro), not the [Miele Triflex](/go/miele-triflex).',
    }),
  );

  assert.deepEqual(droppedSlugs, []);
  assert.deepEqual(healedSlugs, ['miele-triflex']);
  assert.deepEqual((frontmatter.picks as Array<{ goSlug: string }>).map((p) => p.goSlug), [
    'shark-detect-pro',
  ]);
});

// ── Healing an unresolvable /go/ slug ────────────────────────────────────────
// A slug with no dossier product behind it used to be stripped out of the body
// and then counted as a reason to fail the piece. The draft names the product
// twice - in the words on the link and in the slug itself - and a search
// destination needs nothing else, so the link is rebuilt instead. The gate
// below only fires once that has been tried.

test('a slug the dossier never carried is linked from its own anchor text', async () => {
  const { affiliateLinks, body, healedSlugs, droppedSlugs } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: '## Our pick\n\nThe [Miele Triflex HX2](/go/miele-triflex-hx2) is the quiet one.',
    }),
  );

  assert.deepEqual(healedSlugs, ['miele-triflex-hx2']);
  assert.deepEqual(droppedSlugs, []);
  assert.match(body, /\[Miele Triflex HX2\]\(\/go\/miele-triflex-hx2\)/, 'the link survives');

  const healed = affiliateLinks.find((link) => link.slug === 'miele-triflex-hx2')!;
  assert.equal(healed.default_url, 'https://www.amazon.com.au/s?k=Miele%20Triflex%20HX2');
  assert.deepEqual(healed.regions_json, { network: 'amazon', search: 'Miele Triflex HX2' });
  assert.match(healed.note, /healed from anchor text, no dossier product behind it/);
  // What keeps the publisher from letting this guess overwrite another
  // article's dossier-backed row for the same product slug.
  assert.equal(healed.healed, true);
  assert.equal(affiliateLinks.find((link) => link.slug === 'shark-detect-pro')?.healed, undefined);
});

test('markdown emphasis around the name is not part of the search term', async () => {
  const { affiliateLinks } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: '## Our pick\n\nThe [**Miele Triflex HX2**](/go/miele-triflex-hx2) is the quiet one.',
    }),
  );

  assert.equal(affiliateLinks[0].regions_json?.search, 'Miele Triflex HX2');
});

test('a resolved product is never overwritten by its anchor text', async () => {
  // The dossier is the better source: it carries the brand, and (where one
  // survived the liveness probe) the ASIN. Healing only fills holes.
  const { affiliateLinks, healedSlugs } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: '## Our pick\n\n[the one we like](/go/shark-detect-pro) is the buy.',
    }),
  );

  assert.deepEqual(healedSlugs, []);
  assert.equal(affiliateLinks[0].regions_json?.search, 'Shark Detect Pro');
  assert.match(affiliateLinks[0].note, /^Shark Detect Pro/);
});

test('anchor text that names no product is still stripped', async () => {
  // "Check the price" points at a product without saying which one. A search
  // for those words is worse than no link: it sends a reader nowhere useful
  // and still spends the click.
  const { affiliateLinks, body, droppedSlugs, healedSlugs } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: linkedBody + '\n\n[Check the price](/go/todays-best-deal) before you commit.',
    }),
  );

  assert.deepEqual(healedSlugs, []);
  assert.deepEqual(droppedSlugs, ['todays-best-deal']);
  assert.equal(affiliateLinks.length, 2, 'only the two dossier products ship');
  assert.match(body, /Check the price before you commit\./);
  assert.doesNotMatch(body, /\/go\/todays-best-deal/);
});

test('a bare /go/ reference with no anchor text at all is stripped', async () => {
  const { droppedSlugs, healedSlugs } = await runAssembler(
    article({
      research: twoProducts,
      keyword_plan: vacuumPlan,
      draft_md: linkedBody + '\n\nSee /go/miele-triflex for the quiet one.',
    }),
  );

  assert.deepEqual(healedSlugs, []);
  assert.deepEqual(droppedSlugs, ['miele-triflex']);
});

test('a commercial piece whose only links are healed publishes', async () => {
  // The Z Fold 8 shape: three real products named in the body, a dossier that
  // carries none of them, and a gate that used to fail the piece for it.
  const noProducts = { ...(twoProducts as unknown as Record<string, unknown>), products: [] } as never;

  const { affiliateLinks, healedSlugs } = await runAssembler(
    article({
      research: noProducts,
      keyword_plan: vacuumPlan,
      draft_md:
        '## The one to buy\n\nThe [Samsung Galaxy Z Fold 8](/go/samsung-galaxy-z-fold-8) folds flat, ' +
        'the [Samsung Galaxy Z Fold 8 Ultra](/go/samsung-galaxy-z-fold-8-ultra) costs more, and the ' +
        '[Samsung Galaxy Z Flip 8](/go/samsung-galaxy-z-flip-8) fits a pocket.',
    }),
  );

  assert.equal(healedSlugs.length, 3);
  assert.deepEqual(
    affiliateLinks.map((link) => link.default_url),
    [
      'https://www.amazon.com.au/s?k=Samsung%20Galaxy%20Z%20Fold%208',
      'https://www.amazon.com.au/s?k=Samsung%20Galaxy%20Z%20Fold%208%20Ultra',
      'https://www.amazon.com.au/s?k=Samsung%20Galaxy%20Z%20Flip%208',
    ],
  );
});

test('a link labelled the way the contract prescribes is healed from its slug', async () => {
  // LINK_PLACEMENT_RULES tells the writer to put a "Where to buy" column in
  // the comparison table (which sits above the per-product sections) and to
  // end each section with a CTA that says where it goes. Both are anchors
  // that name no product, so the slug - a product name kebab-cased - is what
  // the destination gets built from. Searching Amazon for "view at Amazon AU"
  // would ship a sponsored link to a results page for nothing.
  const noProducts = { ...(twoProducts as unknown as Record<string, unknown>), products: [] } as never;

  const { affiliateLinks, healedSlugs, droppedSlugs } = await runAssembler(
    article({
      research: noProducts,
      keyword_plan: vacuumPlan,
      draft_md:
        '| Phone | Where to buy |\n| --- | --- |\n' +
        '| Z Fold 8 | [Check price on Amazon](/go/samsung-galaxy-z-fold-8) |\n\n' +
        '## The one to buy\n\nIt folds flat.\n\n[view at Amazon AU](/go/samsung-galaxy-z-fold-8)',
    }),
  );

  assert.deepEqual(droppedSlugs, []);
  assert.deepEqual(healedSlugs, ['samsung-galaxy-z-fold-8']);
  assert.equal(
    affiliateLinks[0].default_url,
    'https://www.amazon.com.au/s?k=samsung%20galaxy%20z%20fold%208',
  );
  assert.match(affiliateLinks[0].note, /healed from its \/go\/ slug/);
});

test('the name in the prose outranks the call to action above it', async () => {
  const noProducts = { ...(twoProducts as unknown as Record<string, unknown>), products: [] } as never;

  const { affiliateLinks } = await runAssembler(
    article({
      research: noProducts,
      keyword_plan: vacuumPlan,
      draft_md:
        '| Z Fold 8 | [Check price on Amazon](/go/samsung-galaxy-z-fold-8) |\n\n' +
        '## The one to buy\n\nThe [Samsung Galaxy Z Fold 8 Ultra](/go/samsung-galaxy-z-fold-8) is it.',
    }),
  );

  assert.equal(affiliateLinks[0].regions_json?.search, 'Samsung Galaxy Z Fold 8 Ultra');
});

test('the gate fires only after healing, and reports what healing recovered', async () => {
  await assert.rejects(
    runAssembler(
      article({
        research: oneProduct,
        keyword_plan: plan('Commercial Investigation'),
        draft_md: '## Our pick\n\n[Check the price](/go/todays-best-deal) before you commit.',
      }),
    ),
    (err: Error) => {
      assert.match(err.message, /healing recovered 0 of 1/);
      assert.match(err.message, /nothing nameable in: todays-best-deal/);
      assert.match(err.message, /nothing on the page for a reader to click/);
      // Commission on a launch-window piece settles 6-12+ weeks after the
      // traffic, so the gate does not get to claim what a page would earn.
      assert.doesNotMatch(err.message, /earn/i);
      return true;
    },
  );
});

test('a nameless dossier product is skipped rather than failing the assembly', async () => {
  // frontmatter.picks[].name is required by the site schema, so a broken
  // dossier row would otherwise take the whole article down with it.
  const nameless = {
    ...(twoProducts as unknown as { products: Array<Record<string, unknown>> }),
    products: [{ name: '  ', brand: 'Shark', approxPrice: '', amazonUrl: null, goSlug: 'shark-detect-pro', notes: '' }],
  } as never;

  const { frontmatter, affiliateLinks } = await runAssembler(
    article({
      research: nameless,
      keyword_plan: vacuumPlan,
      draft_md: '## Our pick\n\n[Shark Detect Pro](/go/shark-detect-pro) is the one to buy.',
    }),
  );

  assert.equal('picks' in frontmatter, false);
  assert.equal(affiliateLinks.length, 1, 'the affiliate row behind the link still ships');
});

test('the tier, date and publisher the researcher filed a source under ride through', async () => {
  const tiered = {
    ...(twoProducts as unknown as { facts: Array<Record<string, unknown>> }),
    facts: [
      {
        fact: 'Rated 210AW on high.',
        sourceUrl: 'https://www.choice.com.au/vacuums',
        tier: 'expert',
        date: '2026-03',
        publisher: 'Choice',
      },
      {
        fact: 'Owners report brush-bar tangles.',
        sourceUrl: 'https://www.productreview.com.au/shark',
        tier: 'unknown',
        date: null,
        publisher: null,
      },
    ],
  } as never;

  const { frontmatter } = await runAssembler(
    article({ research: tiered, keyword_plan: vacuumPlan, draft_md: linkedBody }),
  );

  assert.deepEqual(frontmatter.sources, [
    {
      url: 'https://www.choice.com.au/vacuums',
      publisher: 'Choice',
      date: '2026-03',
      tier: 'expert',
    },
    {
      url: 'https://www.productreview.com.au/shark',
      publisher: 'productreview.com.au',
      tier: 'unknown',
    },
  ]);
});

test('the sources shown are the ones the body cites, and a marker past the end goes', async () => {
  // The visible list and the markers in the prose are two views of one
  // derivation: a marker that survives assembly always has an entry behind it.
  const cited =
    '## Our picks\n\n[Shark Detect Pro](/go/shark-detect-pro) lost suction as the filter clogged.[1] ' +
    'Owners report tangles.[2] Nobody published a teardown.[5] ' +
    'The [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.';

  const { frontmatter, body } = await runAssembler(
    article({ research: twoProducts, keyword_plan: vacuumPlan, draft_md: cited }),
  );

  const sources = frontmatter.sources as Array<{ url: string }>;
  assert.equal(sources.length, 2);
  assert.deepEqual(citedSourceIndexes(body), [1, 2]);
  assert.doesNotMatch(body, /\[5\]/);
  assert.match(body, /teardown\. Th/, 'the sentence survives, only the broken marker goes');
});

test('every assembly stamps the date a human last reviewed the piece', async () => {
  const today = new Date().toISOString().slice(0, 10);

  const fresh = await runAssembler(article());
  assert.equal(fresh.frontmatter.lastReviewed, today);
  assert.equal(fresh.frontmatter.pubDate, today);

  // A re-assembly keeps the original publication date and still re-stamps the
  // review: "reviewed today" and "published in June" are different promises.
  const revisited = await runAssembler(article({ frontmatter: { pubDate: '2026-06-01' } }));
  assert.equal(revisited.frontmatter.pubDate, '2026-06-01');
  assert.equal(revisited.frontmatter.updatedDate, today);
  assert.equal(revisited.frontmatter.lastReviewed, today);
});

test('an article with no research or keyword plan carries no structured-data fields', async () => {
  const { frontmatter } = await runAssembler(article());

  assert.equal('sources' in frontmatter, false);
  assert.equal('entities' in frontmatter, false);
  assert.equal('picks' in frontmatter, false);
  assert.equal(frontmatter.currency, 'AUD');
});

// ── Launch-window evidence, through the real assembler ───────────────────────
// The assembler is the only writer of frontmatter, so this is the layer the
// page's tier labels, launch notice and provenance line actually come from.

/** The dossier a launch piece files: no lab result yet, both halves of one spec. */
const launchResearch = {
  summary: 'The iPhone 18 Pro, four days in.',
  facts: [
    { fact: 'Apple states a 3,000-nit peak.', sourceUrl: 'https://www.apple.com/au/iphone-18-pro/',
      tier: 'primary', date: '2026-09-09', publisher: 'Apple' },
  ],
  products: [
    { name: 'iPhone 18 Pro', brand: 'Apple', approxPrice: 'A$2,199', amazonUrl: null,
      goSlug: 'iphone-18-pro', notes: '' },
  ],
  failureModes: [],
  whoShouldNotBuy: [],
  ownerComplaints: [],
  priceObservations: [],
  testedClaims: [],
  claims: [
    {
      subject: 'iPhone 18 Pro',
      metric: 'Peak brightness',
      claimedValue: '3,000 nits',
      claimedBy: 'Apple',
      claimedSourceUrl: 'https://www.apple.com/au/iphone-18-pro/',
      claimedConditions: 'HDR highlights, outdoors',
      measuredValue: '1,684 nits',
      measuredBy: 'Notebookcheck',
      conditions: 'spectrophotometer, 10% APL',
      measuredOn: '2026-09-16',
      measuredSourceUrl: 'https://www.notebookcheck.net/iphone-18-pro',
      withdrawnValue: '2,140 nits',
      ownTest: false,
      covers: null,
    },
  ],
  launch: { product: 'iPhone 18 Pro', releaseDate: '2026-09-11',
    sourceUrl: 'https://www.apple.com/au/newsroom/' },
  keywords: { primary: 'iphone 18 pro', secondary: [] },
  competitorNotes: '',
  faqIdeas: [],
};

const launchDraft = '## The screen\n\nThe [iPhone 18 Pro](/go/iphone-18-pro) ships on 11 September.[1]';

test('the tier-labelled claims, the launch date and the provenance all reach frontmatter', async () => {
  const { frontmatter } = await runAssembler(
    article({ research: launchResearch as never, draft_md: launchDraft }),
  );

  assert.deepEqual(frontmatter.claims, [
    {
      subject: 'iPhone 18 Pro',
      goSlug: 'iphone-18-pro',
      metric: 'Peak brightness',
      tier: 'independent',
      value: '1,684 nits',
      attribution: 'Notebookcheck',
      conditions: 'spectrophotometer, 10% APL',
      date: '2026-09-16',
      sourceUrl: 'https://www.notebookcheck.net/iphone-18-pro',
      withdrawn: '2,140 nits',
      claimed: {
        value: '3,000 nits',
        by: 'Apple',
        conditions: 'HDR highlights, outdoors',
        sourceUrl: 'https://www.apple.com/au/iphone-18-pro/',
      },
    },
  ]);
  assert.deepEqual(frontmatter.launch, {
    product: 'iPhone 18 Pro',
    releaseDate: '2026-09-11',
    sourceUrl: 'https://www.apple.com/au/newsroom/',
  });
  // Stated even - especially - when there was no unit: silence is the case
  // where the reader's assumption is the wrong one.
  assert.deepEqual(frontmatter.reviewUnit, { acquisition: 'none' });
});

test('the measuring source joins the list with its protocol, after the facts', async () => {
  const { frontmatter } = await runAssembler(
    article({ research: launchResearch as never, draft_md: launchDraft }),
  );
  assert.deepEqual(frontmatter.sources, [
    { url: 'https://www.apple.com/au/iphone-18-pro/', publisher: 'Apple', date: '2026-09-09', tier: 'primary' },
    {
      url: 'https://www.notebookcheck.net/iphone-18-pro',
      publisher: 'Notebookcheck',
      date: '2026-09-16',
      tier: 'expert',
      metric: 'Peak brightness',
      measured: '1,684 nits',
      conditions: 'spectrophotometer, 10% APL',
      withdrawn: '2,140 nits',
    },
  ]);
});

test('every pick carries an evidence chip, and an unmeasured one says so', async () => {
  const { frontmatter } = await runAssembler(
    article({ research: launchResearch as never, draft_md: launchDraft }),
  );
  assert.deepEqual(frontmatter.picks, [
    { name: 'iPhone 18 Pro', brand: 'Apple', price: 'A$2,199', goSlug: 'iphone-18-pro',
      evidence: 'researched' },
  ]);
});

test('a badge resting on a maker claim alone fails assembly', async () => {
  // The correct terminal failure: a roundup whose picks rest on the maker's
  // own numbers has nothing to award a badge on.
  const makerOnly = {
    ...launchResearch,
    claims: [
      {
        ...launchResearch.claims[0],
        measuredValue: null,
        measuredBy: null,
        measuredSourceUrl: null,
        withdrawnValue: null,
      },
    ],
  };
  await assert.rejects(
    runAssembler(
      article({
        research: makerOnly as never,
        draft_md: launchDraft,
        frontmatter: { picks: [{ goSlug: 'iphone-18-pro', badge: 'Best overall' }] },
      }),
    ),
    /never rests on a manufacturer claim alone/,
  );
});

test('a brand survey attached to a model it does not cover fails assembly', async () => {
  const brandSurvey = {
    ...launchResearch,
    claims: [
      {
        ...launchResearch.claims[0],
        metric: 'Customer satisfaction',
        claimedValue: null,
        claimedBy: null,
        claimedSourceUrl: null,
        claimedConditions: null,
        measuredValue: '4 stars',
        measuredBy: 'Canstar Blue',
        measuredSourceUrl: 'https://www.canstarblue.com.au/phones/apple/',
        withdrawnValue: null,
        covers: 'Apple as a brand, 2026 mobile phone provider survey',
      },
    ],
  };
  await assert.rejects(
    runAssembler(article({ research: brandSurvey as never, draft_md: launchDraft })),
    /never evidence about a model it does not cover/,
  );
});
