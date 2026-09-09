/**
 * Which deployments may be indexed, and the two ways that can go wrong.
 *
 * Both failure modes are silent and neither breaks a build:
 *
 *  - **A preview that indexes itself.** `develop` is held at the same code level
 *    as `main` and renders the same pages from the same live editorial content,
 *    so an indexable preview is a complete second copy of the site competing
 *    with the real one for its own rankings - and, to an AdSense reviewer,
 *    duplicated content on a domain the account does not own.
 *  - **Production noindexing itself.** Strictly worse, and invisible for weeks:
 *    the site keeps building and deploying while dropping out of the index.
 *
 * The rule fails safe toward the first (anything not explicitly `production` is
 * a preview), so the second is what needs a guard - hence the workflow tests at
 * the end, which read the deploy configuration as text the way `taxonomy.test.ts`
 * reads the taxonomy doc.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { deploymentOf } from './site-env.ts';

/** A deploy workflow, read as text from the repo root. */
const workflow = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

test('only the exact string production is a production deployment', () => {
  assert.equal(deploymentOf('production'), 'production');
  assert.equal(deploymentOf('  production  '), 'production', 'a stray newline must not de-list the site');
});

test('everything else is a preview, including the values nobody meant to write', () => {
  // The point of the fail-safe direction: a preview environment added later is
  // safe because it did nothing, not because someone remembered this file.
  [
    undefined,
    '',
    '   ',
    'preview',
    'develop',
    'staging',
    'Production', // case matters - this is not the value
    'production ish',
    'prod',
    'true',
  ].forEach((raw) => {
    assert.equal(deploymentOf(raw), 'preview', `${JSON.stringify(raw)} must not be indexable`);
  });
});

test('the production deploy marks itself indexable', () => {
  // This line is load-bearing for the whole site's search presence: removing it
  // does not break the build, it silently de-lists sleekdrops.com.
  assert.match(
    workflow('deploy-production.yml'),
    /^\s*PUBLIC_SITE_ENV:\s*production\s*$/m,
    'deploy-production.yml must set PUBLIC_SITE_ENV: production, or the live site noindexes itself',
  );
});

test('the develop deploy does not', () => {
  const assignment = /^\s*PUBLIC_SITE_ENV:\s*(.*)$/m.exec(workflow('deploy-develop.yml'));
  assert.ok(assignment, 'deploy-develop.yml no longer sets PUBLIC_SITE_ENV at all');
  assert.equal(
    deploymentOf(assignment[1]),
    'preview',
    'develop must not be marked production - it renders the same pages as the live site',
  );
});
