import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GOOGLE_EU_CONSENT_REGIONS } from './google-consent.ts';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the AdSense bootstrap sets region-aware Consent Mode v2 defaults before the publisher tag', () => {
  const component = source('../components/ads/GoogleConsent.astro');
  const consent = component.indexOf("window.gtag('consent', 'default'");
  const tag = component.indexOf('<script is:inline async');
  assert.ok(consent >= 0 && tag >= 0 && consent < tag);
  assert.match(component, /analytics_storage: 'denied'/);
  assert.match(component, /region: consentRegions/);
  for (const signal of ['ad_storage', 'ad_user_data', 'ad_personalization']) {
    assert.match(component, new RegExp(`${signal}: 'granted'`));
    assert.match(component, new RegExp(`${signal}: 'denied'`));
  }
});

test('the European message boundary is exactly the EEA, UK and Switzerland', () => {
  assert.equal(GOOGLE_EU_CONSENT_REGIONS.length, 32);
  for (const region of ['AT', 'FR', 'GB', 'IS', 'LI', 'NO', 'CH'] as const) {
    assert.ok(GOOGLE_EU_CONSENT_REGIONS.includes(region));
  }
  for (const region of ['AU', 'CA', 'NZ', 'US']) {
    assert.ok(!GOOGLE_EU_CONSENT_REGIONS.includes(region as never));
  }
});

test('the privacy policy explicitly opts out of the AdSense/CMP bootstrap', () => {
  assert.match(source('../pages/privacy.astro'), /allowAdvertising=\{false\}/);
  assert.match(source('../layouts/BaseLayout.astro'), /allowAdvertising && <GoogleConsent \/>/);
});
