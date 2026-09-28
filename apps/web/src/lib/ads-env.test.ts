/**
 * The ad partner's site id as the build reads it.
 *
 * `adsEnv()` itself reads `import.meta.env`, which Vite inlines at build time and
 * the bare `node --test` runner does not have, so the rules are exercised through
 * the functions `adsEnv()` puts every value through - and the two deploy
 * workflows are read as text, the way `site-env.test.ts` reads them, because the
 * preview invariant below is a property of the deploy configuration rather than
 * of any module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SCRIPT_WRAPPER_ORIGIN,
  scriptWrapperSrc,
  siteId,
  siteIdForDeployment,
} from './ads-env.ts';

/** A deploy workflow, read as text from the repo root. */
const workflow = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

const SITE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('a site id is passed through, whitespace and all', () => {
  assert.equal(siteId(SITE), SITE);
  assert.equal(siteId(`  ${SITE}\n`), SITE);
  assert.equal(siteId('sleekdrops-journey-2026'), 'sleekdrops-journey-2026');
});

test('an unconfigured build has no site id', () => {
  assert.equal(siteId(undefined), '');
  assert.equal(siteId(''), '');
  assert.equal(siteId('   '), '');
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
    assert.equal(siteId(raw), '', `${JSON.stringify(raw)} is not a site id`);
  });
});

test('the wrapper is requested from the partner origin, from the id alone', () => {
  assert.equal(scriptWrapperSrc(SITE), `${SCRIPT_WRAPPER_ORIGIN}/tags/${SITE}.js`);
  assert.equal(scriptWrapperSrc(''), '');
  assert.match(SCRIPT_WRAPPER_ORIGIN, /^https:\/\//, 'the wrapper is loaded over https only');
});

test('only production may expose the site id', () => {
  assert.equal(siteIdForDeployment('production', SITE), SITE);
  assert.equal(siteIdForDeployment('preview', SITE), '');
});

/**
 * The develop deploy must serve no ads, and must not be able to acquire the site
 * id by inheritance.
 *
 * The wrapper is issued for `sleekdrops.com`; `sleekdrops.pages.dev` is a
 * different domain that Mediavine has not approved, and the id is the same
 * account-wide - so a repo-level `MEDIAVINE_SITE_ID` is the natural mistake, at
 * which point a `vars.MEDIAVINE_SITE_ID` lookup on develop would silently start
 * resolving to it.
 */
test('the develop deploy pins the site id empty rather than reading a variable', () => {
  const assignment = /^\s*PUBLIC_MEDIAVINE_SITE_ID:\s*(.*)$/m.exec(workflow('deploy-develop.yml'));
  assert.ok(assignment, 'deploy-develop.yml no longer sets PUBLIC_MEDIAVINE_SITE_ID at all');
  assert.match(
    assignment[1].trim(),
    /^(''|"")$/,
    'develop must pin PUBLIC_MEDIAVINE_SITE_ID to the empty string - a vars.* lookup ' +
      'here inherits any repo- or org-level MEDIAVINE_SITE_ID that is ever added',
  );
  assert.doesNotMatch(workflow('deploy-develop.yml'), /ADS_TXT_URL/, 'a preview publishes no seller record');
});

test('the production deploy reads its site id and ads.txt source from configuration', () => {
  // The other half: pinning develop empty must not have been done by pinning
  // both, which would serve no ads anywhere and read as a partner outage.
  const production = workflow('deploy-production.yml');
  assert.match(production, /PUBLIC_MEDIAVINE_SITE_ID:\s*\$\{\{\s*vars\.MEDIAVINE_SITE_ID\s*\}\}/);
  assert.match(production, /ADS_TXT_URL:\s*\$\{\{\s*vars\.ADS_TXT_URL\s*\}\}/);
});

test('nothing in the deploy configuration still names the previous partner', () => {
  for (const name of ['deploy-develop.yml', 'deploy-production.yml']) {
    assert.doesNotMatch(workflow(name), /ADSENSE/i, `${name} still carries an AdSense setting`);
  }
});
