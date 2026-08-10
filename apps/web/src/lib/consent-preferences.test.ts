/**
 * The reopen-preferences channel, both ends of it.
 *
 * The channel is only worth anything if the two components that ship it are
 * actually wired to it, and neither of them can be imported here (an `.astro`
 * island script sets its page up the moment it runs), so those two are read as
 * text - the approach `hero-cta.test.ts` and `analytics.test.ts` already use for
 * the files a test cannot execute.
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
const BANNER = '../components/layout/ConsentBanner.astro';
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

test('the consent island listens for the request and reopens its dialog on it', () => {
  const banner = source(BANNER);
  assert.match(banner, /onOpenConsentPreferences\(document, openPrefs\)/);
  // show() is what un-hides the root that dismiss() closed for good once a
  // decision was on file, so the dialog has to be opened through it.
  assert.match(banner, /const openPrefs[\s\S]*?show\('prefs'\)/);
  // Reopened over a saved choice, the switch has to show that choice.
  assert.match(banner, /analyticsSwitch\.checked = consentStatus\(\) === 'granted'/);
  // And closing it must not resurrect the prompt the choice was made on: the
  // surface behind the dialog is spent the moment the visitor decides. Without
  // this, accepting and then reopening from the footer on the same page brings
  // the first-visit banner back when the dialog closes.
  assert.match(banner, /const dismiss[\s\S]*?previousSurface = null/);
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
