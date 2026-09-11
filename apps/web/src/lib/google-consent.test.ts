import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the AdSense bootstrap sets denied Consent Mode v2 defaults before the publisher tag', () => {
  const component = source('../components/ads/GoogleConsent.astro');
  const consent = component.indexOf("window.gtag('consent', 'default'");
  const tag = component.indexOf('<script is:inline async');
  assert.ok(consent >= 0 && tag >= 0 && consent < tag);
  for (const signal of ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization']) {
    assert.match(component, new RegExp(`${signal}: 'denied'`));
  }
});

test('the privacy policy explicitly opts out of the AdSense/CMP bootstrap', () => {
  assert.match(source('../pages/privacy.astro'), /allowAdvertising=\{false\}/);
  assert.match(source('../layouts/BaseLayout.astro'), /allowAdvertising && <GoogleConsent \/>/);
});
