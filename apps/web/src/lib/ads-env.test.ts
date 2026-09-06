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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { publisherId } from './ads-env.ts';

/** A deploy workflow, read as text from the repo root. */
const workflow = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

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

/**
 * The develop deploy must publish no publisher id, and must not be able to
 * acquire one by inheritance.
 *
 * `sleekdrops.pages.dev` is a different domain from `sleekdrops.com` and is not
 * in the AdSense account's Sites list. A publisher id there puts an `/ads.txt`
 * and a `google-adsense-account` tag on an unlisted domain claiming the account
 * - the shape of a review failure - and since develop tracks main closely, this
 * one workflow line is the entire difference between the two environments.
 *
 * Read as text, the way `taxonomy.test.ts` reads the taxonomy doc: it is a
 * property of the deploy configuration rather than of any module, and the way it
 * regresses is somebody adding a repo-level `ADSENSE_CLIENT` because the
 * publisher id genuinely is the same account-wide - at which point a
 * `vars.ADSENSE_CLIENT` lookup on develop silently starts resolving to it.
 */
test('the develop deploy pins the publisher id empty rather than reading a variable', () => {
  const assignment = /^\s*PUBLIC_ADSENSE_CLIENT:\s*(.*)$/m.exec(workflow('deploy-develop.yml'));
  assert.ok(assignment, 'deploy-develop.yml no longer sets PUBLIC_ADSENSE_CLIENT at all');
  assert.match(
    assignment[1].trim(),
    /^(''|"")$/,
    'develop must pin PUBLIC_ADSENSE_CLIENT to the empty string - a vars.* lookup ' +
      'here inherits any repo- or org-level ADSENSE_CLIENT that is ever added',
  );
});

test('the production deploy still reads its publisher id from configuration', () => {
  // The other half: pinning develop empty must not have been done by pinning
  // both, which would disable ads everywhere and read as an AdSense outage.
  assert.match(
    workflow('deploy-production.yml'),
    /PUBLIC_ADSENSE_CLIENT:\s*\$\{\{\s*vars\.ADSENSE_CLIENT\s*\}\}/,
  );
});
