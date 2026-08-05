import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrub,
  redactEmails,
  urlToPath,
  stripUrlQueries,
  CLIENT_ERROR_EVENT,
  EXPERIMENT_PROP_PREFIX,
} from './pii.ts';

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

test('keeps the exposure event dimensions the A/B Testing tab measures on', () => {
  const out = scrub(
    { experiment_key: 'hero_cta_copy', variant_key: 'shorter-copy' },
    '$experiment_viewed',
  );
  assert.deepEqual(out, {
    experiment_key: 'hero_cta_copy',
    variant_key: 'shorter-copy',
  });
});

test('keeps sticky $exp_* stamps on any event, alongside that event\'s own props', () => {
  // Experiment keys are minted in the A/B Testing tab, so they survive by
  // prefix rule - a literal allowlist entry could never name them.
  const out = scrub({
    cta: 'Read the latest',
    [`${EXPERIMENT_PROP_PREFIX}hero_cta_copy`]: 'shorter-copy',
    [`${EXPERIMENT_PROP_PREFIX}drop_panel_order`]: 'control',
  });
  assert.deepEqual(out, {
    cta: 'Read the latest',
    $exp_hero_cta_copy: 'shorter-copy',
    $exp_drop_panel_order: 'control',
  });
});

test('still drops properties that only resemble the experiment prefix', () => {
  const out = scrub({ exp_hero: 'x', $experiment: 'y', $exp: 'z' });
  assert.deepEqual(out, {});
});

test('the experiment prefix is not a hole for non-primitive values', () => {
  const out = scrub({
    $exp_nested: { email: 'jordan@example.com' },
    $exp_list: ['a', 'b'],
    $exp_ok: 'control',
  });
  assert.deepEqual(out, { $exp_ok: 'control' });
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

test('stripUrlQueries drops the query and fragment from an embedded URL', () => {
  assert.equal(
    stripUrlQueries('failed at https://sleekdrops.com/app.js?token=secret#x line 3'),
    'failed at https://sleekdrops.com/app.js line 3',
  );
  assert.equal(stripUrlQueries('no url here'), 'no url here');
});

test('drops the error-only diagnostic fields for a non-error event', () => {
  // `source` is a real structural dimension (utm source) so it survives, but
  // the error-specific fields are dropped outside CLIENT_ERROR_EVENT.
  const out = scrub({
    message: 'TypeError: x is not a function',
    source: 'newsletter',
    lineno: 12,
    colno: 8,
    stack: 'Error\n  at f (app.js:12:8)',
    handled: false,
  });
  assert.deepEqual(out, { source: 'newsletter' });
});

test('keeps the full diagnostic payload for $client_error', () => {
  const out = scrub(
    {
      message: 'TypeError: x is not a function',
      source: 'https://sleekdrops.com/assets/app.js',
      lineno: 12,
      colno: 8,
      stack: 'Error\n  at f (https://sleekdrops.com/assets/app.js:12:8)',
      handled: false,
    },
    CLIENT_ERROR_EVENT,
  );
  assert.deepEqual(out, {
    message: 'TypeError: x is not a function',
    source: 'https://sleekdrops.com/assets/app.js',
    lineno: 12,
    colno: 8,
    stack: 'Error\n  at f (https://sleekdrops.com/assets/app.js:12:8)',
    handled: false,
  });
});

test('scrubs PII out of the surviving $client_error free-text fields', () => {
  const out = scrub(
    {
      message: 'Bad request for jordan@example.com at https://sleekdrops.com/api?token=secret&q=hi',
      source: 'https://sleekdrops.com/app.js?v=deadbeef',
      stack: 'Error: jordan@example.com\n  at https://sleekdrops.com/app.js?token=secret line 1',
    },
    CLIENT_ERROR_EVENT,
  );
  assert.deepEqual(out, {
    message: 'Bad request for [redacted] at https://sleekdrops.com/api',
    source: 'https://sleekdrops.com/app.js',
    stack: 'Error: [redacted]\n  at https://sleekdrops.com/app.js line 1',
  });
});

test('rejects mistyped $client_error fields without crashing', () => {
  const out = scrub(
    {
      message: 'boom',
      lineno: 'not-a-number',
      handled: 'nope',
      stack: 42,
    },
    CLIENT_ERROR_EVENT,
  );
  assert.deepEqual(out, { message: 'boom' });
});
