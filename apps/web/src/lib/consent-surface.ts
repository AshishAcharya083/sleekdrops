/**
 * The consent island's surface state machine - which of the three surfaces is on
 * screen, which prompt (if any) is still waiting behind the preferences dialog,
 * and where focus goes when that dialog closes.
 *
 * It lives here rather than in the ConsentBanner island script so it can be tested:
 * an `.astro` island sets its page up the moment it runs, so nothing inside it is
 * reachable from a test, and the path that matters most is the one with no prompt
 * at all - a returning visitor whose decision is already on file, for whom the
 * footer control is the only way back to it.
 *
 * The DOM is passed in as plain `hidden` / `checked` / `focus()` handles rather
 * than queried here, so the `.astro` file stays wiring and the decisions live in
 * one testable place - the `./anchor-scroll`, `./nav-experiment` pattern.
 */

import { onOpenConsentPreferences } from './consent-preferences.ts';
import type { ConsentPrompt, ConsentStatus } from './consent.ts';

export type SurfaceName = 'banner' | 'gpc' | 'prefs';

/** A prompt surface: the one the visitor's decision is taken on. */
export type PromptSurface = Exclude<SurfaceName, 'prefs'>;

/** Anything the island shows and hides - the root and each surface. */
export interface Hidable {
  hidden: boolean;
}

/** Anything focus can be handed back to. */
export interface Focusable {
  focus(): void;
}

export interface ConsentSurfaceDom {
  /** The island root, hidden whenever no surface is on screen. */
  root: Hidable & { contains(node: unknown): boolean };
  /** The surfaces the root holds; a missing one is simply never shown. */
  surfaces: Record<SurfaceName, Hidable | null>;
  /** The analytics toggle in the preferences dialog, pre-filled on open. */
  analyticsSwitch: { checked: boolean } | null;
  /** Where a request to reopen the dialog arrives - the document, in the browser. */
  channel: EventTarget;
  /** The consent decision in force, or null while the visitor has not made one. */
  consentStatus: () => ConsentStatus | null;
  /** What holds focus right now, so the dialog can hand it back when it closes. */
  activeElement: () => Focusable | null;
  /** Focus trap and initial focus, which stay with the island that owns the DOM. */
  onPrefsOpened?: () => void;
  onPrefsClosed?: () => void;
}

export interface ConsentSurface {
  /** Reveal the surface this page load's consent prompt calls for, if any. */
  start(prompt: ConsentPrompt): void;
  openPrefs(): void;
  closePrefs(): void;
  /** Put the consent UI away for good: the prompt behind it has been answered. */
  dismiss(): void;
}

export function createConsentSurface(dom: ConsentSurfaceDom): ConsentSurface {
  const { root, surfaces, analyticsSwitch, channel, consentStatus, activeElement } = dom;

  /** The prompt waiting behind the dialog, or null once it has been answered. */
  let promptSurface: PromptSurface | null = null;
  let returnFocusTo: Focusable | null = null;

  const show = (name: SurfaceName): void => {
    root.hidden = false;
    (Object.keys(surfaces) as SurfaceName[]).forEach((key) => {
      const surface = surfaces[key];
      if (surface) surface.hidden = key !== name;
    });
  };

  /**
   * The control the dialog owes focus to, claimed. Reading it clears it, because
   * the debt is only owed once: leaving it set means the next close hands focus
   * back a second time, which on the first-visit banner scrolls the visitor away
   * to wherever they opened the dialog from.
   */
  const claimFocusReturn = (): Focusable | null => {
    const target = returnFocusTo;
    returnFocusTo = null;
    return target;
  };

  const dismiss = (): void => {
    root.hidden = true;
    dom.onPrefsClosed?.();
    // The caller has made a decision, so the prompt it was made on is spent:
    // reopening the dialog from the footer later and closing it must put the
    // consent UI away, not bring back a banner asking for a choice already made on
    // this very page.
    promptSurface = null;
    // Whatever opened the dialog from outside gets focus back - the footer control,
    // when the visitor reopened their preferences from there and saved or closed. A
    // control inside this root is hidden now and cannot take it.
    const opener = claimFocusReturn();
    if (opener && !root.contains(opener)) opener.focus();
  };

  const openPrefs = (): void => {
    returnFocusTo = activeElement();
    // Pre-filled from the decision actually in force, so a visitor reopening this
    // from the footer sees what they last saved rather than the opt-in default -
    // and saving without touching the switch changes nothing.
    if (analyticsSwitch) analyticsSwitch.checked = consentStatus() === 'granted';
    show('prefs');
    dom.onPrefsOpened?.();
  };

  const closePrefs = (): void => {
    dom.onPrefsClosed?.();
    // With no prompt behind it - the dialog was reopened from the footer over a page
    // whose decision is already on file - closing puts the consent UI away entirely.
    if (!promptSurface) {
      dismiss();
      return;
    }
    show(promptSurface);
    claimFocusReturn()?.focus();
  };

  const start = (prompt: ConsentPrompt): void => {
    if (prompt === 'banner' || prompt === 'policy-update') {
      promptSurface = 'banner';
      show('banner');
    } else if (prompt === 'gpc') {
      promptSurface = 'gpc';
      show('gpc');
    }
  };

  // The way back in, wired before any prompt is resolved. Once a decision is on file
  // boot() reports 'none' on every later load and this root never opens by itself,
  // so a listener registered only on the prompting paths would leave exactly the
  // visitor who needs the footer control unable to use it.
  onOpenConsentPreferences(channel, openPrefs);

  return { start, openPrefs, closePrefs, dismiss };
}
