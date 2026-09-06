/**
 * The privacy-preferences dialog, driven the way the island drives it.
 *
 * Every test here is about the one path there is: a visitor with a decision in
 * force (the default, or something they saved), no prompt on the page, and the
 * footer control as the only way to the dialog. That path has nothing to fall
 * back on, so a listener that is not registered up front leaves the control
 * clicking into nothing - the regression this module was extracted to make
 * impossible.
 *
 * The DOM is a handful of plain objects, because the module takes `hidden` /
 * `checked` / `focus()` handles rather than querying anything itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ConsentCategory } from './consent.ts';
import { openConsentPreferences } from './consent-preferences.ts';
import { createPreferencesSurface, type Focusable, type PreferencesSurface } from './consent-surface.ts';

/** A control focus can be handed to, and whether it sits inside the dialog's root. */
interface Control extends Focusable {
  readonly name: string;
  readonly insideRoot: boolean;
}

/**
 * One rendered island: its root, the dialog, the category switches, the document
 * event the footer control dispatches on, and a record of every `focus()` the
 * module asked for, in order.
 */
function island(granted: Partial<Record<ConsentCategory, boolean>> = {}) {
  const root = {
    hidden: true,
    contains: (node: unknown): boolean => (node as Control | null)?.insideRoot === true,
  };
  const dialog = { hidden: true };
  const analyticsSwitch = { checked: false };
  const adsSwitch = { checked: false };
  const channel = new EventTarget();
  const focused: string[] = [];
  const opened: string[] = [];
  let active: Control | null = null;

  const control = (name: string, insideRoot: boolean): Control => ({
    name,
    insideRoot,
    focus: () => void focused.push(name),
  });
  /** The footer's "Privacy preferences" button - the one way in. */
  const footerControl = control('footer', false);
  /** The dialog's own Save button, which the root hides along with itself. */
  const saveControl = control('save', true);

  const surface: PreferencesSurface = createPreferencesSurface({
    root,
    dialog,
    switches: { analytics: analyticsSwitch, ads: adsSwitch },
    channel,
    isGranted: (category) => granted[category] === true,
    activeElement: () => active,
    onOpened: () => void opened.push('opened'),
    onClosed: () => void opened.push('closed'),
  });

  return {
    root,
    dialog,
    analyticsSwitch,
    adsSwitch,
    focused,
    opened,
    footerControl,
    saveControl,
    surface,
    /** Click a control: it takes focus, as a real click does, then acts. */
    clickFrom(target: Control, act: () => void): void {
      active = target;
      act();
    },
    /** What the footer control does: dispatch the document event. */
    requestFromFooter(): void {
      this.clickFrom(footerControl, () => openConsentPreferences(channel));
    },
  };
}

test('nothing is shown until something asks for the dialog', () => {
  const page = island();
  assert.equal(page.root.hidden, true);
  assert.equal(page.dialog.hidden, true);
  assert.deepEqual(page.opened, []);
});

test('the footer request opens the dialog, with the focus trap armed', () => {
  const page = island();
  page.requestFromFooter();
  assert.equal(page.root.hidden, false);
  assert.equal(page.dialog.hidden, false);
  assert.deepEqual(page.opened, ['opened']);
});

test('each category switch is pre-filled from the decision in force', () => {
  // The default: analytics on, ads off - so the dialog opens showing exactly that,
  // and saving without touching a switch changes nothing.
  const asDefault = island({ analytics: true, ads: false });
  asDefault.requestFromFooter();
  assert.equal(asDefault.analyticsSwitch.checked, true);
  assert.equal(asDefault.adsSwitch.checked, false);

  const optedIn = island({ analytics: true, ads: true });
  optedIn.requestFromFooter();
  assert.equal(optedIn.adsSwitch.checked, true);
});

test('a withdrawal is shown as withdrawn, not as the default', () => {
  const page = island({ analytics: false, ads: false });
  page.requestFromFooter();
  assert.equal(page.analyticsSwitch.checked, false);
  assert.equal(page.adsSwitch.checked, false);
});

test('closing puts the dialog away and hands focus back to the footer control', () => {
  const page = island();
  page.requestFromFooter();
  page.clickFrom(page.saveControl, () => page.surface.close());
  assert.equal(page.root.hidden, true);
  assert.equal(page.dialog.hidden, true);
  assert.deepEqual(page.focused, ['footer']);
  assert.deepEqual(page.opened, ['opened', 'closed']);
});

test('the request works again and again, so a visitor can change their mind twice', () => {
  const page = island({ analytics: true });
  page.requestFromFooter();
  page.surface.close();
  page.requestFromFooter();
  assert.equal(page.root.hidden, false, 'the listener must survive the first close');
  page.surface.close();
  assert.equal(page.root.hidden, true);
  assert.deepEqual(page.focused, ['footer', 'footer']);
});

test('the focus debt is paid once: a second close does not focus the footer again', () => {
  const page = island();
  page.requestFromFooter();
  page.surface.close();
  page.surface.close();
  assert.deepEqual(page.focused, ['footer']);
});

test('focus is never handed back to a control the island has just hidden', () => {
  // Opened programmatically from inside the root (no footer involved): closing
  // must not try to focus a now-hidden control.
  const page = island();
  page.clickFrom(page.saveControl, () => page.surface.open());
  page.surface.close();
  assert.deepEqual(page.focused, []);
});
