/**
 * The linked entity graph a post ships, and the ItemList a guide or roundup
 * adds on top of it.
 *
 * Generative engines build their knowledge graph out of exactly this markup,
 * so what is pinned here is the wiring: entities and citations carried through
 * frontmatter, one Product node per recommended pick with the site's own
 * currency, no rating we award ourselves, and posts published before any of
 * these fields existed still emitting a valid graph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildArticleSchema, buildPostSchema, buildReviewSchema } from './seo.ts';
import type { BlogPost } from './posts.ts';
import type { Author } from '@data/authors';

const author: Author = {
  id: 'mira',
  name: 'Mira Kapoor',
  role: 'Senior reviews editor',
  bio: 'Reviews homewares.',
};

const BODY = `Cordless sticks are worth it for flats.

## Our picks

The [Shark Detect Pro](/go/shark-detect-pro) is the one to buy.`;

/** A guide the pipeline produced after this change: picks, sources, entities. */
function guide(overrides: Record<string, unknown> = {}): BlogPost {
  return {
    slug: 'best-cordless-stick-vacuums',
    body: BODY,
    data: {
      title: 'The best cordless stick vacuums in Australia',
      dek: 'Three worth buying, and what they cost.',
      category: 'Home',
      postType: 'guide',
      author: 'mira',
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
  // "Cordless ... flats." (7) + "Our picks" (2) + "The Shark Detect Pro ... buy." (9)
  assert.equal(article.wordCount, 18);
});

test('the byline knows about its beat and this section, not its job title', () => {
  const person = node(buildArticleSchema(guide(), author), 'Person');
  assert.deepEqual(person.knowsAbout, ['Home']);
  assert.equal(person.jobTitle, 'Senior reviews editor');

  const audio = { ...author, id: 'theo', name: 'Theo Renn', role: 'Audio & tech' };
  const techPost = guide({ category: 'Tech' });
  assert.deepEqual(node(buildArticleSchema(techPost, audio), 'Person').knowsAbout, [
    'Audio',
    'Tech',
  ]);
});

// ── The ItemList a guide or roundup emits ───────────────────────────────────

test('a guide emits a Rich Results-shaped ItemList of its picks', () => {
  const schema = buildArticleSchema(guide(), author);
  const list = node(schema, 'ItemList');

  assert.equal(list['@id'], 'https://sleekdrops.com/blog/best-cordless-stick-vacuums#picks');
  assert.equal(list.numberOfItems, 3);
  assert.equal(list.itemListOrder, 'https://schema.org/ItemListOrderAscending');

  const elements = list.itemListElement as Node[];
  assert.equal(elements.length, 3);
  elements.forEach((element, index) => {
    assert.equal(element['@type'], 'ListItem');
    assert.equal(element.position, index + 1, 'positions are 1-based and consecutive');
    const item = element.item as Node;
    assert.equal(item['@type'], 'Product');
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
  });

  const top = elements[0].item as Node;
  assert.equal(
    top['@id'],
    'https://sleekdrops.com/blog/best-cordless-stick-vacuums#pick-shark-detect-pro',
  );
  assert.deepEqual(top.brand, { '@type': 'Brand', name: 'Shark' });
  assert.deepEqual(top.offers, {
    '@type': 'Offer',
    price: '1199',
    priceCurrency: 'AUD',
    url: 'https://sleekdrops.com/go/shark-detect-pro',
  });
  // "$1099.00" keeps its cents; a pick with no stated price gets no offer
  // rather than an invented one.
  assert.equal(((elements[1].item as Node).offers as Node).price, '1099.00');
  assert.equal('offers' in (elements[2].item as Node), false);

  // The article says the list is what it is about, so the two resolve as one.
  assert.deepEqual(node(schema, 'Article').mainEntity, { '@id': list['@id'] });
});

test("the currency is the post's own, never a hardcoded USD", () => {
  const json = JSON.stringify(buildArticleSchema(guide(), author));
  assert.ok(!json.includes('USD'));
  assert.ok(json.includes('"priceCurrency":"AUD"'));

  // A post written before the field existed still gets the site default.
  const legacy = guide({ currency: undefined });
  const offer = (
    (node(buildArticleSchema(legacy, author), 'ItemList').itemListElement as Node[])[0].item as Node
  ).offers as Node;
  assert.equal(offer.priceCurrency, 'AUD');
});

test('no rating is applied to a product we earn commission on', () => {
  const json = JSON.stringify(buildArticleSchema(guide(), author));
  assert.ok(!json.includes('aggregateRating'));
  assert.ok(!json.includes('ratingValue'));
});

test('only guides and roundups turn their picks into a list', () => {
  const roundup = guide({ postType: 'roundup' });
  assert.equal(node(buildArticleSchema(roundup, author), 'ItemList')['@type'], 'ItemList');

  const plain = buildArticleSchema(guide({ postType: 'article' }), author);
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
      author: 'mira',
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
    author: 'mira',
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
  assert.deepEqual(review.author, { '@id': 'https://sleekdrops.com/author/mira#person' });
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

  const guideGraph = nodes(buildPostSchema(guide(), author));
  assert.ok(guideGraph.some((n) => n['@type'] === 'ItemList'));
  assert.equal(guideGraph.some((n) => n['@type'] === 'Review'), false);
});

test('a price is read off its currency symbol, never off a year beside it', () => {
  const priced = guide({
    picks: [
      { name: 'A', price: '2026 model, $199', goSlug: 'a' },
      { name: 'B', price: 'RRP A$1,199 (2026)', goSlug: 'b' },
      { name: 'C', price: 'from 89.95', goSlug: 'c' },
      { name: 'D', price: 'price on application', goSlug: 'd' },
    ],
  });
  const items = (node(buildArticleSchema(priced, author), 'ItemList').itemListElement as Node[]).map(
    (element) => (element.item as Node).offers as Node | undefined,
  );
  assert.deepEqual(items.map((offer) => offer?.price), ['199', '1199', '89.95', undefined]);
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
  assert.match(page, /buildPostSchema\(post, author\)/);
  assert.doesNotMatch(page, /buildArticleSchema|buildReviewSchema/);
});
