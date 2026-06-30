import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scrub, redactEmails, urlToPath } from './pii.ts';

test('drops free-text fields not on the allowlist', () => {
  const out = scrub({
    search: 'how to cancel my jordan@example.com subscription',
    query: 'noise cancelling headphones for $email',
    comment: 'call me on 555-0100',
    message: 'anything you type',
    email: 'jordan.alvarez-mcgrath@example-domain.co.uk',
    name: 'Jordan Alvarez',
  });
  assert.deepEqual(out, {});
});

test('keeps allowlisted structural dimensions', () => {
  const out = scrub({
    category: 'headphones',
    slug: 'sony-wh-1000xm6',
    position: 3,
    variant: 'hero',
    theme: 'dark',
  });
  assert.deepEqual(out, {
    category: 'headphones',
    slug: 'sony-wh-1000xm6',
    position: 3,
    variant: 'hero',
    theme: 'dark',
  });
});

test('reduces url fields to path, dropping the raw query string', () => {
  const out = scrub({
    url: 'https://sleekdrops.com/guides/best-anc?email=jordan@example.com&q=secret#frag',
    referrer: 'https://google.com/search?q=who+is+jordan',
    path: '/deals?utm_campaign=spring&token=abc',
  });
  assert.deepEqual(out, {
    url: '/guides/best-anc',
    referrer: '/search',
    path: '/deals',
  });
});

test('redacts emails embedded in surviving string values', () => {
  const out = scrub({ title: 'Email us at help@sleekdrops.com for support' });
  assert.equal(out.title, 'Email us at [redacted] for support');
});

test('drops null, undefined, and non-primitive values', () => {
  const out = scrub({
    category: null,
    slug: undefined,
    variant: { nested: 'jordan@example.com' },
    position: ['a', 'b'],
  });
  assert.deepEqual(out, {});
});

test('returns an empty object for empty or missing input', () => {
  assert.deepEqual(scrub(), {});
  assert.deepEqual(scrub(null), {});
  assert.deepEqual(scrub({}), {});
});

test('redactEmails handles multiple addresses in one string', () => {
  assert.equal(
    redactEmails('a@b.com and c.d+tag@e-f.co.uk'),
    '[redacted] and [redacted]',
  );
});

test('urlToPath strips query and fragment from absolute and relative inputs', () => {
  assert.equal(urlToPath('https://x.com/a/b?c=d#e'), '/a/b');
  assert.equal(urlToPath('/a/b?c=d'), '/a/b');
  assert.equal(urlToPath('/clean'), '/clean');
});
