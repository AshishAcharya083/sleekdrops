import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveAnalyticsEnv } from './analytics-env.ts';

const workflow = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');

test('a configured preview enables DevTeam analytics without a prompt', () => {
  assert.deepEqual(
    resolveAnalyticsEnv('preview', {
      key: ' dtp_develop ',
      host: ' https://ingest.test/ ',
      feedback: 'true',
    }),
    {
      key: 'dtp_develop',
      host: 'https://ingest.test/',
      feedback: true,
      defaultConsent: 'granted',
    },
  );
});

test('an unconfigured preview has no DevTeam sink, and analytics still defaults on', () => {
  // GA4 is configured separately (PUBLIC_GA4_ID); a preview without a DevTeam
  // key must not read as a preview without analytics.
  assert.deepEqual(resolveAnalyticsEnv('preview', { host: 'https://ingest.test', feedback: 'true' }), {
    key: '',
    host: '',
    feedback: false,
    defaultConsent: 'granted',
  });
});

test('production refuses a DevTeam key and feedback even when supplied', () => {
  assert.deepEqual(
    resolveAnalyticsEnv('production', {
      key: 'dtp_must_not_ship',
      host: 'https://ingest.test',
      feedback: 'true',
    }),
    {
      key: '',
      host: '',
      feedback: false,
      defaultConsent: 'granted',
    },
  );
});

test('REGRESSION: production defaults analytics on, so GA4 counts every visit', () => {
  // From 2026-09-12 to 2026-09-28 production resolved this to `denied`, which
  // loaded gtag.js only for a visitor who opened the footer dialog and switched
  // analytics on. The GA4 property reported "No data received" for the whole
  // period while every deploy was green, and the Mediavine application - which
  // reads sessions from that property - could not qualify. The default is the
  // site's policy (opt-out, Australian publisher), not a per-deployment
  // convenience, so it is asserted on the deployment that matters.
  assert.equal(resolveAnalyticsEnv('production', {}).defaultConsent, 'granted');
  assert.equal(resolveAnalyticsEnv('preview', {}).defaultConsent, 'granted');
});

test('the develop workflow supplies the configured analytics environment', () => {
  const develop = workflow('deploy-develop.yml');
  assert.match(
    develop,
    /^\s*PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY:\s*\$\{\{ secrets\.DEVTEAM_ANALYTICS_INGEST_KEY \}\}\s*$/m,
  );
  assert.match(
    develop,
    /^\s*PUBLIC_DEVTEAM_ANALYTICS_HOST:\s*\$\{\{ vars\.DEVTEAM_ANALYTICS_HOST \}\}\s*$/m,
  );
});

test('the production workflow supplies no DevTeam analytics configuration', () => {
  const production = workflow('deploy-production.yml');
  assert.match(production, /^\s*PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY:\s*''\s*$/m);
  assert.match(production, /^\s*PUBLIC_DEVTEAM_ANALYTICS_HOST:\s*''\s*$/m);
});
