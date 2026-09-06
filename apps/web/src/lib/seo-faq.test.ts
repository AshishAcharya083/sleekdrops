/**
 * FAQ extraction feeds FAQPage structured data, which is the strongest signal
 * we ship for being cited by AI Overviews, ChatGPT and Perplexity. It reads
 * the published markdown rather than a frontmatter field, so it has to survive
 * whatever an article body actually contains: /go/ links inside answers, a
 * "FAQs" heading, code fences, and posts with no FAQ section at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFaqSchema, extractFaq } from './seo.ts';

const ARTICLE = `Some opening prose about vacuums.

## How we picked

We read the spec sheets and owner reviews.

## FAQ

### Are cordless vacuums worth it?
Yes for flats and hard floors. The runtime is the constraint: 40 minutes on
eco, closer to 8 on max.

### Can I get a good one under $500?
Yes. The [KARDV V06](/go/kardv-v06) sits around **$100** and cleans carpet well.

## The verdict

Buy the Shark.`;

test('pulls every question and answer out of the FAQ section', () => {
  const faq = extractFaq(ARTICLE);
  assert.equal(faq.length, 2);
  assert.equal(faq[0].question, 'Are cordless vacuums worth it?');
  assert.match(faq[0].answer, /^Yes for flats and hard floors\./);
  assert.match(faq[0].answer, /closer to 8 on max\.$/);
});

test('answers keep the link text and drop the markdown', () => {
  const answer = extractFaq(ARTICLE)[1].answer;
  assert.equal(answer, 'Yes. The KARDV V06 sits around $100 and cleans carpet well.');
});

test('sections before and after the FAQ are not swept in', () => {
  const questions = extractFaq(ARTICLE).map((f) => f.question);
  assert.ok(!questions.some((q) => /How we picked|verdict/i.test(q)));
});

test('a post with no FAQ section yields nothing', () => {
  assert.deepEqual(extractFaq('## Our pick\n\nThe Shark.\n\n### Why\n\nSuction.'), []);
  assert.deepEqual(extractFaq(''), []);
  assert.deepEqual(extractFaq(undefined as unknown as string), []);
});

test('"FAQs" and "Frequently asked questions" are both recognised', () => {
  for (const heading of ['## FAQs', '## Frequently asked questions', '## FAQ']) {
    const faq = extractFaq(`${heading}\n\n### A?\nOne.\n\n### B?\nTwo.`);
    assert.equal(faq.length, 2, `${heading} should be recognised`);
  }
});

test('a question with no answer under it is dropped', () => {
  const faq = extractFaq('## FAQ\n\n### Empty?\n\n### Answered?\nIt is.');
  assert.deepEqual(faq, [{ question: 'Answered?', answer: 'It is.' }]);
});

test('a code fence inside an answer does not end the FAQ section', () => {
  const faq = extractFaq(
    '## FAQ\n\n### How?\nLike this:\n\n```\n## Not a heading\n```\n\n### And then?\nDone.',
  );
  assert.equal(faq.length, 2);
  assert.equal(faq[1].question, 'And then?');
});

test('a long answer is truncated at a sentence boundary', () => {
  const sentence = 'The runtime is the constraint on every cordless vacuum sold here. ';
  const faq = extractFaq(`## FAQ\n\n### Why?\n${sentence.repeat(12)}`);
  assert.ok(faq[0].answer.length <= 500);
  assert.ok(faq[0].answer.endsWith('.'), `ended with: ${faq[0].answer.slice(-40)}`);
});

test('buildFaqSchema emits FAQPage for two or more entries', () => {
  const schema = buildFaqSchema(extractFaq(ARTICLE));
  assert.ok(schema);
  assert.equal(schema!['@type'], 'FAQPage');
  assert.equal(schema!['@context'], 'https://schema.org');
  const entities = schema!.mainEntity as Array<Record<string, unknown>>;
  assert.equal(entities.length, 2);
  assert.equal(entities[0]['@type'], 'Question');
  assert.equal(entities[0].name, 'Are cordless vacuums worth it?');
  assert.deepEqual(entities[0].acceptedAnswer, {
    '@type': 'Answer',
    text: extractFaq(ARTICLE)[0].answer,
  });
});

test('buildFaqSchema declines below two entries — a single-question FAQPage earns nothing', () => {
  assert.equal(buildFaqSchema([]), null);
  assert.equal(buildFaqSchema([{ question: 'Only one?', answer: 'Yes.' }]), null);
});
