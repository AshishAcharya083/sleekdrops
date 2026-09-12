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

test('an unconfigured preview keeps analytics off', () => {
  assert.deepEqual(resolveAnalyticsEnv('preview', { host: 'https://ingest.test', feedback: 'true' }), {
    key: '',
    host: '',
    feedback: false,
    defaultConsent: 'denied',
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
      defaultConsent: 'denied',
    },
  );
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
