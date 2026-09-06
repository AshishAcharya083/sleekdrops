/**
 * The privacy-preferences dialog's state - when it is on screen, what its
 * switches show, and where focus goes when it closes.
 *
 * Nothing opens this dialog by itself. There is no first-visit banner and no
 * re-prompt any more (see `./consent`): the one way in is the footer's Privacy
 * preferences control, which asks over the document event in
 * `./consent-preferences`. That path is exactly what this module exists to keep
 * working - an island script sets its page up the moment it runs, so nothing
 * inside it is reachable from a test, and the footer control clicking into
 * nothing is the regression this was extracted to make impossible.
 *
 * The DOM is passed in as plain `hidden` / `checked` / `focus()` handles rather
 * than queried here, so the `.astro` file stays wiring and the decisions live in
 * one testable place - the `./anchor-scroll`, `./nav-experiment` pattern.
 */

import { onOpenConsentPreferences } from './consent-preferences.ts';
import { CONSENT_CATEGORIES, type ConsentCategory } from './consent.ts';

/** Anything the island shows and hides - the root and the dialog. */
export interface Hidable {
  hidden: boolean;
}

/** Anything focus can be handed back to. */
export interface Focusable {
  focus(): void;
}

/** A category toggle in the preferences dialog. */
export interface Switchable {
  checked: boolean;
}

export interface PreferencesDom {
  /** The island root, hidden whenever the dialog is not on screen. */
  root: Hidable & { contains(node: unknown): boolean };
  /** The dialog itself; a missing one is simply never shown. */
  dialog: Hidable | null;
  /**
   * One toggle per non-essential category, pre-filled on open. Keyed by category
   * so a category added to `./consent` cannot be silently left off the dialog: a
   * missing key is simply never shown, and the type says which ones exist.
   */
  switches: Partial<Record<ConsentCategory, Switchable | null>>;
  /** Where a request to open the dialog arrives - the document, in the browser. */
  channel: EventTarget;
  /** Whether one category is granted right now, for that pre-fill. */
  isGranted: (category: ConsentCategory) => boolean;
  /** What holds focus right now, so the dialog can hand it back when it closes. */
  activeElement: () => Focusable | null;
  /** Focus trap and initial focus, which stay with the island that owns the DOM. */
  onOpened?: () => void;
  onClosed?: () => void;
}

export interface PreferencesSurface {
  open(): void;
  /** Put the dialog away, whether the visitor saved, declined or just closed it. */
  close(): void;
}

export function createPreferencesSurface(dom: PreferencesDom): PreferencesSurface {
  const { root, dialog, switches, channel, isGranted, activeElement } = dom;

  let returnFocusTo: Focusable | null = null;

  /**
   * The control the dialog owes focus to, claimed. Reading it clears it, because
   * the debt is only owed once: leaving it set means the next close hands focus
   * back a second time, scrolling the visitor away to wherever they opened the
   * dialog from.
   */
  const claimFocusReturn = (): Focusable | null => {
    const target = returnFocusTo;
    returnFocusTo = null;
    return target;
  };

  const open = (): void => {
    returnFocusTo = activeElement();
    // Pre-filled from the decision actually in force, so the visitor sees what
    // applies right now - the default, or what they last saved - and saving
    // without touching a switch changes nothing.
    CONSENT_CATEGORIES.forEach((category) => {
      const control = switches[category];
      if (control) control.checked = isGranted(category);
    });
    root.hidden = false;
    if (dialog) dialog.hidden = false;
    dom.onOpened?.();
  };

  const close = (): void => {
    root.hidden = true;
    if (dialog) dialog.hidden = true;
    dom.onClosed?.();
    // Whatever opened the dialog gets focus back - the footer control. A control
    // inside this root is hidden now and cannot take it.
    const opener = claimFocusReturn();
    if (opener && !root.contains(opener)) opener.focus();
  };

  onOpenConsentPreferences(channel, open);

  return { open, close };
}
