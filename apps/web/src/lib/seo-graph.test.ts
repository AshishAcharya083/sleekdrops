/**
 * The linked entity graph a post ships, and the ItemList a guide or roundup
 * adds on top of it.
 *
 * Generative engines build their knowledge graph out of exactly this markup,
 * so what is pinned here is the wiring: entities and citations carried through
 * frontmatter, one Product node per recommended pick anchored to the section
 * that recommends it, no price we do not print and no rating we award
 * ourselves, and posts published before any of these fields existed still
 * emitting a valid graph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildArticleSchema, buildPostSchema, buildReviewSchema, jsonLdScript } from './seo.ts';
import type { PostHeading } from './seo.ts';
import type { BlogPost } from './posts.ts';
import type { Author } from '@data/authors';

const author: Author = {
  id: 'desk',
  name: 'SleekDrops Editorial Desk',
  role: 'Editorial team',
  bio: 'Research-led coverage.',
};

const BODY = `Cordless sticks are worth it for flats.

## Shark Detect Pro

The [Shark Detect Pro](/go/shark-detect-pro) is the one to buy.

## Dyson V15 Detect

The [Dyson V15 Detect](/go/dyson-v15-detect) costs more.

## Ecovacs T30S

The [Ecovacs T30S](/go/ecovacs-t30s) mops too.`;

/** What `post.render()` hands back for BODY — the ids Astro put on the H2s. */
const HEADINGS: PostHeading[] = [
  { depth: 2, slug: 'shark-detect-pro', text: 'Shark Detect Pro' },
  { depth: 2, slug: 'dyson-v15-detect', text: 'Dyson V15 Detect' },
  { depth: 2, slug: 'ecovacs-t30s', text: 'Ecovacs T30S' },
];

/** A guide the pipeline produced after this change: picks, sources, entities. */
function guide(overrides: Record<string, unknown> = {}, body: string = BODY): BlogPost {
  return {
    slug: 'best-cordless-stick-vacuums',
    body,
    data: {
      title: 'The best cordless stick vacuums in Australia',
      dek: 'Three worth buying, and what they cost.',
      category: 'Home',
      postType: 'guide',
      author: 'desk',
      tags: ['vacuums'],
      pubDate: new Date('2026-08-01T00:00:00Z'),
      updatedDate: new Date('2026-09-05T00:00:00Z'),
      readTime: 9,
      cover: 'fill-2',
      currency: 'AUD',
      sources: [
        { url: 'https://www.choice.com.au/vacuums', publisher: 'choice.com.au' },
        { url: 'https://www.productreview.com.au/shark', publisher: 'productreview.com.au' },
      ],
      entities: ['Dyson', 'Shark', 'Ecovacs', 'HEPA filtration', 'Anti-tangle brush bar'],
      picks: [
        { name: 'Shark Detect Pro', brand: 'Shark', price: 'A$1,199', goSlug: 'shark-detect-pro' },
        { name: 'Dyson V15 Detect', brand: 'Dyson', price: '$1099.00', goSlug: 'dyson-v15-detect' },
        { name: 'Ecovacs T30S', goSlug: 'ecovacs-t30s' },
      ],
      featured: false,
      draft: false,
      ...overrides,
    },
  } as unknown as BlogPost;
}

type Node = Record<string, unknown>;

function nodes(schema: unknown): Node[] {
  return (schema as { '@graph': Node[] })['@graph'];
}

function node(schema: unknown, type: string): Node {
  const found = nodes(schema).find((entry) => entry['@type'] === type);
  assert.ok(found, `no ${type} node in the graph`);
  return found;
}

// ── Entities, citations, word count ─────────────────────────────────────────

test("the keyword plan's entities become about and mentions nodes", () => {
  const article = node(buildArticleSchema(guide(), author), 'Article');

  assert.deepEqual(article.about, [
    { '@type': 'Thing', '@id': 'https://sleekdrops.com/#/entity/dyson', name: 'Dyson' },
    { '@type': 'Thing', '@id': 'https://sleekdrops.com/#/entity/shark', name: 'Shark' },
    { '@type': 'Thing', '@id': 'https://sleekdrops.com/#/entity/ecovacs', name: 'Ecovacs' },
  ]);
  assert.deepEqual((article.mentions as Node[]).map((entity) => entity.name), [
    'HEPA filtration',
    'Anti-tangle brush bar',
  ]);
  assert.equal(
    (article.mentions as Node[])[0]['@id'],
    'https://sleekdrops.com/#/entity/hepa-filtration',
  );
});

test('the dossier sources become citations with their publisher', () => {
  const article = node(buildArticleSchema(guide(), author), 'Article');
  assert.deepEqual(article.citation, [
    {
      '@type': 'WebPage',
      '@id': 'https://www.choice.com.au/vacuums',
      url: 'https://www.choice.com.au/vacuums',
      publisher: { '@type': 'Organization', name: 'choice.com.au' },
    },
    {
      '@type': 'WebPage',
      '@id': 'https://www.productreview.com.au/shark',
      url: 'https://www.productreview.com.au/shark',
      publisher: { '@type': 'Organization', name: 'productreview.com.au' },
    },
  ]);
});

test('wordCount counts the body, not its markdown', () => {
  const article = node(buildArticleSchema(guide(), author), 'Article');
  // Headings count as words, link syntax does not: a link contributes only its
  // anchor text, so "[Shark Detect Pro](/go/shark-detect-pro)" is three words.
  assert.equal(article.wordCount, 35);
});

test('the byline is the editorial desk, and says so the same way on every post', () => {
  const bylineId = 'https://sleekdrops.com/author/desk#byline';
  const home = nodes(buildArticleSchema(guide(), author)).find((n) => n['@id'] === bylineId);
  assert.ok(home, 'no byline node in the graph');
  // Not a Person: the site shows a labelled editorial desk, and markup that
  // claimed a human reviewer would be asserting something the page does not.
  assert.equal(home['@type'], 'Organization');
  assert.equal(home.description, 'Research-led coverage.');
  assert.deepEqual(home.parentOrganization, { '@id': 'https://sleekdrops.com/#organization' });

  // One `@id` means one set of claims, so the section a post sits in cannot
  // change what the desk knows about.
  const tech = nodes(buildArticleSchema(guide({ category: 'Tech' }), author)).find(
    (n) => n['@id'] === bylineId,
  );
  assert.deepEqual(tech, home);
  assert.deepEqual(home.knowsAbout, ['Tech', 'Home', 'Fashion', 'Health', 'Finance', 'Travel']);
});

// ── The ItemList a guide or roundup emits ───────────────────────────────────

test('a guide emits a Rich Results-shaped ItemList of its picks', () => {
  const schema = buildArticleSchema(guide(), author, HEADINGS);
  const list = node(schema, 'ItemList');
  const page = 'https://sleekdrops.com/blog/best-cordless-stick-vacuums';

  assert.equal(list['@id'], `${page}#picks`);
  assert.equal(list.numberOfItems, 3);
  assert.equal(list.itemListOrder, 'https://schema.org/ItemListOrderAscending');

  const elements = list.itemListElement as Node[];
  assert.equal(elements.length, 3);
  // Rich Results reads an all-in-one list as ListItems with consecutive 1-based
  // positions, each naming the thing it points at and where on the page it is.
  elements.forEach((element, index) => {
    assert.equal(element['@type'], 'ListItem');
    assert.equal(element.position, index + 1, 'positions are 1-based and consecutive');
    const item = element.item as Node;
    assert.equal(item['@type'], 'Product');
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
  });

  assert.deepEqual(elements.map((element) => element.url), [
    `${page}#shark-detect-pro`,
    `${page}#dyson-v15-detect`,
    `${page}#ecovacs-t30s`,
  ]);

  const top = elements[0].item as Node;
  assert.equal(top['@id'], `${page}#pick-shark-detect-pro`);
  assert.deepEqual(top.brand, { '@type': 'Brand', name: 'Shark' });
  // No brand stated for the third pick, and none invented for it.
  assert.equal('brand' in (elements[2].item as Node), false);
});

test('the article names its list of picks as what the page is about', () => {
  const schema = buildArticleSchema(guide(), author, HEADINGS);
  assert.deepEqual(node(schema, 'Article').mainEntity, {
    '@id': 'https://sleekdrops.com/blog/best-cordless-stick-vacuums#picks',
  });
});

test("every priced pick carries an Offer in the post's own currency", () => {
  const list = node(buildArticleSchema(guide(), author, HEADINGS), 'ItemList');
  const elements = list.itemListElement as Node[];

  assert.deepEqual((elements[0].item as Node).offers, {
    '@type': 'Offer',
    priceCurrency: 'AUD',
    price: '1199',
    availability: 'https://schema.org/InStock',
    url: 'https://sleekdrops.com/go/shark-detect-pro',
  });
  // The price as the dossier stated it, whatever shape it came in.
  assert.equal(((elements[1].item as Node).offers as Node).price, '1099.00');
  // No figure in the research, so no Offer rather than an invented one.
  assert.equal('offers' in (elements[2].item as Node), false);

  const json = JSON.stringify(buildArticleSchema(guide(), author, HEADINGS));
  assert.ok(!json.includes('USD'), 'the currency comes from the post, never a hardcoded USD');
});

test('a guide written before the currency field existed still prices its picks in AUD', () => {
  const list = node(
    buildArticleSchema(guide({ currency: undefined }), author, HEADINGS),
    'ItemList',
  );
  const offer = ((list.itemListElement as Node[])[0].item as Node).offers as Node;
  assert.equal(offer.priceCurrency, 'AUD');
});

test('no rating is applied to a product we earn commission on', () => {
  const json = JSON.stringify(buildArticleSchema(guide(), author, HEADINGS));
  assert.ok(!json.includes('aggregateRating'));
  assert.ok(!json.includes('ratingValue'));
});

test('a pick the body never links under a heading simply gets no anchor', () => {
  // Headings the renderer did not produce, so nothing can be anchored safely.
  const unanchored = node(buildArticleSchema(guide(), author), 'ItemList');
  assert.equal(
    (unanchored.itemListElement as Node[]).every((element) => !('url' in element)),
    true,
  );

  // And a body whose heading count disagrees with what was rendered anchors
  // nothing rather than pointing every pick one section off.
  const drifted = node(buildArticleSchema(guide(), author, HEADINGS.slice(0, 2)), 'ItemList');
  assert.equal(
    (drifted.itemListElement as Node[]).every((element) => !('url' in element)),
    true,
  );
});

test('picks under nested headings anchor to their own section, not the intro', () => {
  // The shape the pipeline actually writes: one H2 over per-pick H3s, an FAQ
  // after them, and the top pick name-dropped in the intro before any heading.
  const nested = guide(
    {
      picks: [
        { name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' },
        { name: 'Dyson V15 Detect', goSlug: 'dyson-v15-detect' },
      ],
    },
    [
      'Skip to the [Shark Detect Pro](/go/shark-detect-pro) if you are in a hurry.',
      '',
      '## Our picks',
      '',
      '### Shark Detect Pro',
      '',
      'The [Shark Detect Pro](/go/shark-detect-pro) is the one to buy.',
      '',
      '### Dyson V15 Detect',
      '',
      'The [Dyson V15 Detect](/go/dyson-v15-detect) is the upgrade.',
      '',
      '## FAQ',
      '',
      '### Anything else?',
      '',
      'No.',
    ].join('\n'),
  );

  const list = node(
    buildArticleSchema(nested, author, [
      { depth: 2, slug: 'our-picks', text: 'Our picks' },
      { depth: 3, slug: 'shark-detect-pro', text: 'Shark Detect Pro' },
      { depth: 3, slug: 'dyson-v15-detect', text: 'Dyson V15 Detect' },
      { depth: 2, slug: 'faq', text: 'FAQ' },
      { depth: 3, slug: 'anything-else', text: 'Anything else?' },
    ]),
    'ItemList',
  );
  const page = 'https://sleekdrops.com/blog/best-cordless-stick-vacuums';
  assert.deepEqual((list.itemListElement as Node[]).map((element) => element.url), [
    `${page}#shark-detect-pro`,
    `${page}#dyson-v15-detect`,
  ]);
});

test('a /go/ link inside a fenced code block is not mistaken for a pick anchor', () => {
  const fenced = guide(
    { picks: [{ name: 'Shark Detect Pro', goSlug: 'shark-detect-pro' }] },
    [
      '## Intro',
      '',
      '```',
      '[Shark](/go/shark-detect-pro)',
      '```',
      '',
      '## Shark Detect Pro',
      '',
      'The [Shark Detect Pro](/go/shark-detect-pro) is the one to buy.',
    ].join('\n'),
  );

  const list = node(
    buildArticleSchema(fenced, author, [
      { depth: 2, slug: 'intro', text: 'Intro' },
      { depth: 2, slug: 'shark-detect-pro', text: 'Shark Detect Pro' },
    ]),
    'ItemList',
  );
  assert.equal(
    (list.itemListElement as Node[])[0].url,
    'https://sleekdrops.com/blog/best-cordless-stick-vacuums#shark-detect-pro',
  );
});

test('only guides and roundups turn their picks into a list', () => {
  const roundup = guide({ postType: 'roundup' });
  const list = node(buildArticleSchema(roundup, author, HEADINGS), 'ItemList');
  assert.equal(list['@type'], 'ItemList');

  const plain = buildArticleSchema(guide({ postType: 'article' }), author, HEADINGS);
  assert.equal(nodes(plain).some((entry) => entry['@type'] === 'ItemList'), false);
  assert.equal('mainEntity' in node(plain, 'Article'), false);
});

// ── Posts that carry none of the new fields ─────────────────────────────────

test('a post published before any of these fields existed still emits a graph', () => {
  const legacy = {
    slug: 'old-hand-written-post',
    body: 'Short and old.',
    data: {
      title: 'An older post',
      dek: 'Written by hand, long before the pipeline.',
      category: 'Tech',
      postType: 'article',
      author: 'desk',
      tags: [],
      pubDate: new Date('2025-01-01T00:00:00Z'),
      readTime: 3,
      cover: 'fill-1',
      currency: 'AUD',
      featured: false,
      draft: false,
    },
  } as unknown as BlogPost;

  const article = node(buildArticleSchema(legacy, author), 'Article');
  for (const absent of ['about', 'mentions', 'citation', 'mainEntity']) {
    assert.equal(absent in article, false, `${absent} should be absent`);
  }
  assert.equal(article.wordCount, 3);
  assert.deepEqual(article.image, ['https://sleekdrops.com/og-default.png']);
});

// ── The review path ─────────────────────────────────────────────────────────

const reviewPost = {
  slug: 'harman-kardon-luna-2',
  body: 'A short review body.',
  data: {
    title: 'Harman Kardon Luna 2 review',
    dek: 'A balanced, good-looking portable.',
    category: 'Tech',
    postType: 'review',
    author: 'desk',
    tags: ['speakers'],
    pubDate: new Date('2026-05-30T00:00:00Z'),
    readTime: 8,
    cover: 'fill-1',
    currency: 'AUD',
    product: {
      name: 'Harman Kardon Luna 2',
      brand: 'Harman Kardon',
      brandMark: 'H',
      tagline: 'Warm, portable, and worth the money.',
      rating: 4.5,
      retailer: 'Amazon',
      price: 'A$229',
      pros: ['Sound', 'Battery', 'Looks'],
      cons: ['Pricey', 'No aptX'],
    },
    featured: false,
    draft: false,
  },
} as unknown as BlogPost;

test('a review post links its Product and Review through the same graph', () => {
  const schema = buildReviewSchema(reviewPost, author);
  const productId = 'https://sleekdrops.com/blog/harman-kardon-luna-2#product';

  const product = node(schema, 'Product');
  assert.equal(product['@id'], productId);
  assert.deepEqual(product.offers, {
    '@type': 'Offer',
    priceCurrency: 'AUD',
    price: '229',
    availability: 'https://schema.org/InStock',
    url: 'https://sleekdrops.com/go/harman-kardon-luna-2',
  });
  assert.equal('aggregateRating' in product, false);

  const review = node(schema, 'Review');
  assert.deepEqual(review.itemReviewed, { '@id': productId });
  assert.deepEqual(review.author, { '@id': 'https://sleekdrops.com/author/desk#byline' });
  // The one editorial rating stays on the Review, where it belongs.
  assert.deepEqual(review.reviewRating, {
    '@type': 'Rating',
    ratingValue: 4.5,
    bestRating: 5,
    worstRating: 1,
  });

  // The article nodes ride along, so a review page is still a resolvable page.
  assert.equal(
    node(schema, 'Article')['@id'],
    'https://sleekdrops.com/blog/harman-kardon-luna-2#article',
  );
});

test('buildPostSchema sends a review post to the Product graph and everything else to the Article one', () => {
  assert.ok(nodes(buildPostSchema(reviewPost, author)).some((n) => n['@type'] === 'Review'));

  const guideGraph = nodes(buildPostSchema(guide(), author, HEADINGS));
  assert.ok(guideGraph.some((n) => n['@type'] === 'ItemList'));
  assert.equal(guideGraph.some((n) => n['@type'] === 'Review'), false);
});

function reviewPriced(price: string): Node | undefined {
  const post = {
    ...reviewPost,
    data: { ...reviewPost.data, product: { ...reviewPost.data.product, price } },
  } as unknown as BlogPost;
  return node(buildReviewSchema(post, author), 'Product').offers as Node | undefined;
}

test('a displayed price is read off its currency symbol, never off a year beside it', () => {
  assert.equal(reviewPriced('2026 model, $199')?.price, '199');
  assert.equal(reviewPriced('RRP A$1,199 (2026)')?.price, '1199');
  assert.equal(reviewPriced('from 89.95')?.price, '89.95');
  // Nothing numeric to mirror, so no Offer rather than an invented one.
  assert.equal(reviewPriced('price on application'), undefined);
});

test("a review's Offer is priced in the post's own currency, never a hardcoded USD", () => {
  const json = JSON.stringify(buildReviewSchema(reviewPost, author));
  assert.ok(!json.includes('USD'));
  assert.ok(json.includes('"priceCurrency":"AUD"'));

  // A review written before the field existed still gets the site default.
  const legacy = {
    ...reviewPost,
    data: { ...reviewPost.data, currency: undefined },
  } as unknown as BlogPost;
  const offer = node(buildReviewSchema(legacy, author), 'Product').offers as Node;
  assert.equal(offer.priceCurrency, 'AUD');
});

// ── The script tag the graph is rendered into ───────────────────────────────

test('a string that could close the JSON-LD block is escaped, not emitted raw', () => {
  // Source URLs and entity names come from research off the open web, and the
  // script body is written with set:html, which escapes nothing. A raw
  // "</script>" in any string value would end the block early and let whatever
  // followed it run, so the serialiser escapes the angle brackets itself.
  const hostile = guide({
    entities: ['</script><script>alert(1)</script>'],
    sources: [{ url: 'https://evil.example/a</script>' }],
  });
  const schema = buildPostSchema(hostile, author, HEADINGS);

  const serialised = jsonLdScript(schema);

  assert.doesNotMatch(serialised, /[<>]/);
  assert.match(serialised, /\\u003c\/script\\u003e/);
  // Escaping is a transport concern only: the JSON-LD a consumer parses is
  // byte-for-byte the schema the builders returned.
  assert.deepEqual(JSON.parse(serialised), JSON.parse(JSON.stringify(schema)));
});

test('U+2028 and U+2029 are escaped so the inline script stays parseable', () => {
  const separators = guide({ entities: ['Dyson\u2028V15\u2029Detect'] });

  const serialised = jsonLdScript(buildPostSchema(separators, author, HEADINGS));

  assert.doesNotMatch(serialised, /[\u2028\u2029]/);
  assert.match(serialised, /Dyson\\u2028V15\\u2029Detect/);
});

test('the JsonLd component serialises through the escaping helper', () => {
  const component = readFileSync(
    fileURLToPath(new URL('../components/seo/JsonLd.astro', import.meta.url)),
    'utf8',
  );
  assert.match(component, /set:html=\{jsonLdScript\(schema\)\}/);
  assert.doesNotMatch(component, /JSON\.stringify/);
});

// ── The page that actually ships this ───────────────────────────────────────

test('the post page routes every post through buildPostSchema', () => {
  // The builders are only worth what the page emits: this is the wiring that
  // used to send a guide to the thin Article path and never fire the Product
  // one, because it branched on frontmatter instead of asking the router.
  const page = readFileSync(
    fileURLToPath(new URL('../pages/blog/[slug].astro', import.meta.url)),
    'utf8',
  );
  assert.match(page, /buildPostSchema\(post, author, headings\)/);
  assert.doesNotMatch(page, /buildArticleSchema|buildReviewSchema/);
});
