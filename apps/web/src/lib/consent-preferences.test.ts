/**
 * The reopen-preferences channel, both ends of it.
 *
 * The channel is only worth anything if the two components that ship it are
 * actually wired to it, and neither of them can be imported here (an `.astro`
 * island script sets its page up the moment it runs), so those two are read as
 * text - the approach `hero-cta.test.ts` and `analytics.test.ts` already use for
 * the files a test cannot execute. What the island then does with a request it
 * hears is `./consent-surface`, which is executed rather than read: see
 * consent-surface.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONSENT_PREFERENCES_EVENT,
  onOpenConsentPreferences,
  openConsentPreferences,
} from './consent-preferences.ts';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const FOOTER = '../components/layout/Footer.astro';
const BANNER = '../components/layout/PrivacyPreferences.astro';
const PRIVACY = '../pages/privacy.astro';

test('a control asking for preferences reaches the island listening for it', () => {
  const document = new EventTarget();
  let opened = 0;
  onOpenConsentPreferences(document, () => {
    opened += 1;
  });

  openConsentPreferences(document);
  assert.equal(opened, 1);
});

test('the listener stays subscribed, so preferences can be reopened again and again', () => {
  // Withdrawing is not a one-shot: a visitor may open the dialog, close it, and
  // come back to it on the same page.
  const document = new EventTarget();
  let opened = 0;
  onOpenConsentPreferences(document, () => {
    opened += 1;
  });

  openConsentPreferences(document);
  openConsentPreferences(document);
  openConsentPreferences(document);
  assert.equal(opened, 3);
});

test('nothing opens until a control asks', () => {
  const document = new EventTarget();
  let opened = 0;
  onOpenConsentPreferences(document, () => {
    opened += 1;
  });

  document.dispatchEvent(new CustomEvent('consent:something-else'));
  assert.equal(opened, 0);
});

test('both ends are named by the module, so they cannot drift apart', () => {
  // The failure this module exists to prevent is a dispatch nothing hears, which
  // no unit test of either side alone would catch.
  const document = new EventTarget();
  let seen = 0;
  document.addEventListener(CONSENT_PREFERENCES_EVENT, () => {
    seen += 1;
  });

  openConsentPreferences(document);
  assert.equal(seen, 1);
});

test('the footer ships a control that dispatches the request on the document', () => {
  const footer = source(FOOTER);
  assert.match(footer, /data-consent-preferences/);
  assert.match(footer, /openConsentPreferences\(document\)/);
});

test('the footer control is revealed by its own script rather than shipped dead', () => {
  // It opens a client-side dialog, so a visitor without JavaScript must be shown
  // no control at all rather than one that answers a click with nothing.
  const footer = source(FOOTER);
  assert.match(footer, /<button[^>]*data-consent-preferences[^>]*\shidden/);
  assert.match(footer, /\bhidden = false/);
});

test('the preferences island hands the document to the surface that listens on it', () => {
  // What the island does with the request - open the dialog pre-filled, hand focus
  // back exactly once - is `@lib/consent-surface`, asserted for real in
  // consent-surface.test.ts. The one thing only the island can get wrong is which
  // channel that surface listens on, which is the same drift this module exists
  // to prevent. And it must still boot the gate: with no banner, this island is
  // the only place the stored decision (or the default) is applied.
  const island = source(BANNER);
  assert.match(island, /createPreferencesSurface\(\{[\s\S]*?channel: document,/);
  assert.match(island, /\bboot\(\);/);
  assert.doesNotMatch(island, /data-action="(accept|decline|customize)"/, 'no prompt controls remain');
});

test('the promise of a footer control names a control the footer actually ships', () => {
  // The defect this fixes: both of these told the visitor they could change their
  // mind from the footer, and the footer had nothing to change it with.
  const label = 'Privacy preferences';
  const promise = new RegExp(`<strong>${label}</strong> in the footer`);
  assert.match(source(BANNER), promise);
  assert.match(source(PRIVACY), promise);
  assert.match(source(FOOTER), new RegExp(`data-consent-preferences[^>]*>${label}</button>`));
});
