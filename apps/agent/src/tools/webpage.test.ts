// The page reader — the half of fact checking that opens the source. Text
// extraction is where this can quietly go wrong: a page whose script tags
// survive fills the prompt with JSON nobody asked for, and a page whose
// headings fuse into the body reads as one sentence to the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPageText, htmlToText } from './webpage.js';

test('script, style and comment contents never reach the prompt', () => {
  const { text } = htmlToText(
    `<html><head><style>.a{color:red}</style></head>
     <body><script>var price = 999;</script><!-- draft: was $799 -->
     <p>The XM6 sells for $549.</p></body></html>`,
  );
  assert.match(text, /The XM6 sells for \$549\./);
  assert.doesNotMatch(text, /999/);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /799/);
});

test('block boundaries survive as line breaks', () => {
  const { text } = htmlToText('<h2>Battery</h2><p>30 hours with ANC on.</p><p>Sony, 2026.</p>');
  assert.equal(text, 'Battery\n30 hours with ANC on.\nSony, 2026.');
});

test('named and numeric entities both decode, in the title and the body', () => {
  // Product pages are full of numeric entities — an em dash in a title, a
  // hair space inside a price — and left raw they read as punctuation codes.
  const { title } = htmlToText('<html><head><title>Sony &amp; Bose &#8212; compared</title></head></html>');
  assert.equal(title, 'Sony & Bose — compared');
  assert.equal(htmlToText('<p>&#x24;549 &#8212; in stock</p>').text, '$549 — in stock');
});

test('entities in the body are decoded', () => {
  const { text } = htmlToText('<p>Sony&nbsp;&amp;&nbsp;Bose &lt;$500</p>');
  assert.equal(text, 'Sony & Bose <$500');
});

test('a page with no readable content comes back empty, not broken', () => {
  assert.equal(htmlToText('<script>1</script>').text, '');
});

test('only http(s) URLs can be read', async () => {
  // A tool that followed file:// or data: would turn "verify this claim" into
  // a way to read the container.
  for (const url of ['file:///etc/passwd', 'data:text/html,<p>hi', 'ftp://example.com/x']) {
    await assert.rejects(fetchPageText(url), /only http\(s\) URLs/);
  }
  await assert.rejects(fetchPageText('not a url at all'), /not a URL/);
});
