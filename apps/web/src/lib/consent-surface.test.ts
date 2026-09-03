/**
 * The consent island's surface state machine, driven the way the island drives it.
 *
 * The case every test here is really about is the returning visitor: a decision on
 * file, no prompt on the page, and the footer control as the only way back to the
 * choice the dialog and the privacy policy both promise can be changed from there.
 * That path has no banner to fall back on, so a listener that is registered on the
 * prompting paths only - the regression this module was extracted to make
 * impossible - leaves the control clicking into nothing.
 *
 * The DOM is a handful of plain objects, because the module takes `hidden` /
 * `checked` / `focus()` handles rather than querying anything itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConsentCategory } from './consent.ts';
import { openConsentPreferences } from './consent-preferences.ts';
import { createConsentSurface, type ConsentSurface, type Focusable } from './consent-surface.ts';

/** A control focus can be handed to, and whether it sits inside the consent root. */
interface Control extends Focusable {
  readonly name: string;
  readonly insideRoot: boolean;
}

/**
 * One rendered consent island: its root, its three surfaces, the category
 * switches, the document event the footer control dispatches on, and a record of
 * every `focus()` the module asked for, in order.
 */
function island(granted: Partial<Record<ConsentCategory, boolean>> = {}) {
  const root = {
    hidden: true,
    contains: (node: unknown): boolean => (node as Control | null)?.insideRoot === true,
  };
  const surfaces = {
    banner: { hidden: true },
    gpc: { hidden: true },
    prefs: { hidden: true },
  };
  const analyticsSwitch = { checked: false };
  const adsSwitch = { checked: false };
  const channel = new EventTarget();
  const focused: string[] = [];
  let active: Control | null = null;

  const control = (name: string, insideRoot: boolean): Control => ({
    name,
    insideRoot,
    focus: () => void focused.push(name),
  });
  /** The footer's "Privacy preferences" button - the one way back in. */
  const footerControl = control('footer', false);
  /** The banner's own "Customize" button, which the root hides along with itself. */
  const customizeControl = control('customize', true);

  const surface: ConsentSurface = createConsentSurface({
    root,
    surfaces,
    switches: { analytics: analyticsSwitch, ads: adsSwitch },
    channel,
    isGranted: (category) => granted[category] === true,
    activeElement: () => active,
  });

  return {
    root,
    surfaces,
    analyticsSwitch,
    adsSwitch,
    focused,
    footerControl,
    customizeControl,
    surface,
    /** Click a control: it takes focus, as a real click does, then acts. */
    clickFrom(target: Control, act: () => void): void {
      active = target;
      act();
    },
    /** What the footer control's request does when it reaches the island. */
    requestPreferences(): void {
      openConsentPreferences(channel);
    },
    /** The surface on screen, or null when the island is put away. */
    visible(): string | null {
      if (root.hidden) return null;
      return Object.entries(surfaces).find(([, el]) => !el.hidden)?.[0] ?? null;
    },
  };
}

test('a visitor with a decision on file is shown nothing on load', () => {
  const page = island({ analytics: true });
  page.surface.start('none');

  assert.equal(page.root.hidden, true);
  assert.equal(page.visible(), null);
});

test('the footer request reopens the dialog for a visitor who has already decided', () => {
  // The defect: with a decision on file there is no prompt, so this request is the
  // only thing that can ever open the consent UI again.
  const page = island({ analytics: true });
  page.surface.start('none');

  page.clickFrom(page.footerControl, () => page.requestPreferences());

  assert.equal(page.root.hidden, false, 'the root the load left hidden has to reopen');
  assert.equal(page.visible(), 'prefs');
  assert.equal(page.analyticsSwitch.checked, true, 'pre-filled from the decision in force');
  assert.equal(page.adsSwitch.checked, false, 'a category they did not grant stays off');
});

test('each category switch is pre-filled from its own decision', () => {
  // The advertising opt-in is only reachable here, so a dialog that showed it as
  // off to a visitor who turned it on would withdraw it on the next save.
  const page = island({ ads: true });
  page.surface.start('none');

  page.requestPreferences();

  assert.equal(page.adsSwitch.checked, true);
  assert.equal(page.analyticsSwitch.checked, false);
});

test('the reopened dialog shows a withdrawal as withdrawn, not as the opt-in default', () => {
  const page = island({});
  page.surface.start('none');

  page.requestPreferences();

  assert.equal(page.visible(), 'prefs');
  assert.equal(page.analyticsSwitch.checked, false);
});

test('the request works again and again, so a visitor can change their mind twice', () => {
  const page = island({ analytics: true });
  page.surface.start('none');

  page.requestPreferences();
  page.surface.closePrefs();
  page.requestPreferences();

  assert.equal(page.visible(), 'prefs');
});

test('closing a dialog reopened over a decided page puts the consent UI away', () => {
  const page = island({ analytics: true });
  page.surface.start('none');
  page.requestPreferences();

  page.surface.closePrefs();

  assert.equal(page.root.hidden, true, 'there is no prompt behind it to go back to');
  assert.equal(page.visible(), null);
});

test('closing the dialog hands focus back to the control that opened it', () => {
  const page = island({ analytics: true });
  page.surface.start('none');
  page.clickFrom(page.footerControl, () => page.requestPreferences());

  page.surface.closePrefs();

  assert.deepEqual(page.focused, ['footer']);
});

test('on a first visit the dialog opens over the banner and closes back onto it', () => {
  const page = island();
  page.surface.start('banner');
  assert.equal(page.visible(), 'banner');

  page.clickFrom(page.customizeControl, () => page.surface.openPrefs());
  assert.equal(page.visible(), 'prefs');

  page.surface.closePrefs();
  assert.equal(page.visible(), 'banner', 'the choice has not been made yet');
  assert.deepEqual(page.focused, ['customize']);
});

test('a policy-update re-prompt behaves as the first-visit banner does', () => {
  const page = island({ analytics: true });
  page.surface.start('policy-update');
  assert.equal(page.visible(), 'banner');

  page.surface.openPrefs();
  page.surface.closePrefs();
  assert.equal(page.visible(), 'banner');
});

test('the GPC card is what a dialog opened over it closes back onto', () => {
  const page = island();
  page.surface.start('gpc');

  page.surface.openPrefs();
  page.surface.closePrefs();

  assert.equal(page.visible(), 'gpc');
});

test('deciding on the banner spends it, so a later dialog does not resurrect it', () => {
  // Accept, then reopen preferences from the footer on the same page: closing that
  // dialog must not bring back a banner asking for a choice already made here.
  const page = island();
  page.surface.start('banner');
  page.surface.dismiss();

  page.requestPreferences();
  assert.equal(page.visible(), 'prefs');
  page.surface.closePrefs();

  assert.equal(page.root.hidden, true);
});

test('the focus debt is paid once, so deciding on the banner does not jump the page', () => {
  // The regression: open preferences from the footer while the banner is up, press
  // Escape (the banner comes back and focus returns to the footer control), scroll
  // back to the pinned banner and accept. A focus() left owed here lands on the
  // footer control and takes the viewport with it, dumping the visitor at the
  // bottom of the page as their decision is recorded.
  const page = island();
  page.surface.start('banner');
  page.clickFrom(page.footerControl, () => page.requestPreferences());

  page.surface.closePrefs();
  assert.deepEqual(page.focused, ['footer'], 'the banner is back and focus went with it');

  page.surface.dismiss();
  assert.deepEqual(page.focused, ['footer'], 'accepting must not move focus a second time');
});

test('focus is never handed back to a control the island has just hidden', () => {
  const page = island();
  page.surface.start('banner');
  page.clickFrom(page.customizeControl, () => page.surface.openPrefs());

  page.surface.dismiss();

  assert.deepEqual(page.focused, [], 'the Customize button went away with the root');
});
