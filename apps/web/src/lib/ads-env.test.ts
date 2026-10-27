/**
 * The two ad partners' ids as the build reads them: the AdSense publisher id
 * and the Journey by Mediavine site id, which coexist while the site applies to
 * both.
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

import {
  MEDIAVINE_SCRIPT_ORIGIN,
  mediavineScriptSrc,
  mediavineSiteId,
  mediavineSiteIdForDeployment,
  publisherId,
  publisherIdForDeployment,
} from './ads-env.ts';

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

test('only production may expose a valid AdSense publisher id', () => {
  const publisher = 'ca-pub-1234567890123456';
  assert.equal(publisherIdForDeployment('production', publisher), publisher);
  assert.equal(publisherIdForDeployment('preview', publisher), '');
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

const SITE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('a Mediavine site id is passed through, whitespace and all', () => {
  assert.equal(mediavineSiteId(SITE), SITE);
  assert.equal(mediavineSiteId(`  ${SITE}\n`), SITE);
  assert.equal(mediavineSiteId('sleekdrops-journey-2026'), 'sleekdrops-journey-2026');
});

test('an unconfigured build has no Mediavine site id', () => {
  assert.equal(mediavineSiteId(undefined), '');
  assert.equal(mediavineSiteId(''), '');
  assert.equal(mediavineSiteId('   '), '');
});

test('anything that cannot be a wrapper path segment reads as unconfigured', () => {
  // Each of these would be written into a <script src> on every page: a path
  // that escapes the tags directory, a quote that breaks out of the attribute,
  // or a value too short to be an id at all.
  [
    '../other-site',
    'abc',
    `${SITE}.js`,
    `${SITE}?x=1`,
    'id with spaces',
    '"><script>alert(1)</script>',
    `${SITE}\n${SITE}`,
  ].forEach((raw) => {
    assert.equal(mediavineSiteId(raw), '', `${JSON.stringify(raw)} is not a site id`);
  });
});

test('the Journey wrapper is requested from the partner origin, from the id alone', () => {
  assert.equal(mediavineScriptSrc(SITE), `${MEDIAVINE_SCRIPT_ORIGIN}/tags/${SITE}.js`);
  assert.equal(mediavineScriptSrc(''), '');
  assert.match(MEDIAVINE_SCRIPT_ORIGIN, /^https:\/\//, 'the wrapper is loaded over https only');
});

test('only production may expose the Mediavine site id', () => {
  assert.equal(mediavineSiteIdForDeployment('production', SITE), SITE);
  assert.equal(mediavineSiteIdForDeployment('preview', SITE), '');
});

test('the two partners are configured independently', () => {
  // Coexistence: each id is read from its own variable through its own rule,
  // so either partner can be live while the other's id is still empty.
  const publisher = 'ca-pub-1234567890123456';
  assert.equal(publisherId(SITE), '', 'a Mediavine id is never read as a publisher id');
  assert.equal(publisherIdForDeployment('production', publisher), publisher);
  assert.equal(mediavineSiteIdForDeployment('production', ''), '');
  assert.equal(publisherIdForDeployment('production', ''), '');
  assert.equal(mediavineSiteIdForDeployment('production', SITE), SITE);
});

/**
 * The develop deploy must load no Journey wrapper either, and must not be able
 * to acquire the site id by inheritance - for the publisher id's reason: the
 * wrapper is issued for `sleekdrops.com`, `sleekdrops.pages.dev` is a domain
 * the partner has not approved, and the id is the same account-wide, so a
 * repo-level `MEDIAVINE_SITE_ID` is the natural mistake.
 */
test('the develop deploy pins the Mediavine site id empty rather than reading a variable', () => {
  const develop = workflow('deploy-develop.yml');
  const assignment = /^\s*PUBLIC_MEDIAVINE_SITE_ID:\s*(.*)$/m.exec(develop);
  assert.ok(assignment, 'deploy-develop.yml no longer sets PUBLIC_MEDIAVINE_SITE_ID at all');
  assert.match(
    assignment[1].trim(),
    /^(''|"")$/,
    'develop must pin PUBLIC_MEDIAVINE_SITE_ID to the empty string - a vars.* lookup ' +
      'here inherits any repo- or org-level MEDIAVINE_SITE_ID that is ever added',
  );
  assert.doesNotMatch(develop, /ADS_TXT_URL/, 'a preview publishes no seller record');
});

test('the production deploy reads its Mediavine site id and ads.txt source from configuration', () => {
  const production = workflow('deploy-production.yml');
  assert.match(production, /PUBLIC_MEDIAVINE_SITE_ID:\s*\$\{\{\s*vars\.MEDIAVINE_SITE_ID\s*\}\}/);
  assert.match(production, /ADS_TXT_URL:\s*\$\{\{\s*vars\.ADS_TXT_URL\s*\}\}/);
});
