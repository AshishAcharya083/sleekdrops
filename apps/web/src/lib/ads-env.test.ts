/**
 * The publisher id as the build reads it.
 *
 * `scripts/generate-ads-txt.mjs` validates the same variable against the same
 * pattern before it will publish an ads.txt naming that seller, and the two have
 * to agree: a value the generator refuses is a value the page must not ask the
 * partner to serve against either, or the build ships a live ad request carrying
 * an id no crawler can match back to this domain.
 *
 * `adsEnv()` itself reads `import.meta.env`, which Vite inlines at build time and
 * the bare `node --test` runner does not have, so the check is exercised through
 * the function `adsEnv()` puts every publisher id through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { publisherId } from './ads-env.ts';

test('a publisher id is passed through, whitespace and all', () => {
  assert.equal(publisherId('ca-pub-1234567890123456'), 'ca-pub-1234567890123456');
  assert.equal(publisherId('  ca-pub-1234567890123456\n'), 'ca-pub-1234567890123456');
});

test('an unconfigured build has no publisher id', () => {
  assert.equal(publisherId(undefined), '');
  assert.equal(publisherId(''), '');
  assert.equal(publisherId('   '), '');
});

test('anything that is not a publisher id reads as unconfigured', () => {
  // Every one of these is a value the ads.txt generator refuses to write a
  // seller record for, so none of them may reach the partner as an id to serve
  // against: a wrong id serves unmatchable requests instead of failing loudly.
  [
    'pub-1234567890123456', // the ads.txt form, not the tag form
    'ca-pub-', // the prefix with nothing behind it
    'ca-pub-12ab34', // a transcription slip
    'CA-PUB-1234567890123456', // the console shows it lower-case
    'ca-pub-123 456', // a stray space inside the id
    'ca-pub-1234567890123456?x=1', // trailing junk after a valid-looking id
    'ca-pub-123456\ngoogle.com, pub-evil, DIRECT, f08c47fec0942fa0',
    '<script>alert(1)</script>',
  ].forEach((raw) => {
    assert.equal(publisherId(raw), '', `${JSON.stringify(raw)} is not a publisher id`);
  });
});
