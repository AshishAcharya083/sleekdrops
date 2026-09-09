/**
 * The reopen-preferences channel - how a control anywhere on the page asks the
 * PrivacyPreferences island to open its preferences dialog.
 *
 * The banner keeps its surfaces and its show/hide helpers module-local to its own
 * island script, and the footer control is a separate script in a separate
 * component, so the only thing the two share is the document. This module owns
 * both ends of that document event, so the control cannot end up dispatching a
 * name nothing listens for - which is what would quietly break the "you can change
 * this any time from the footer" promise the dialog and the privacy policy both
 * make.
 *
 * Injectable rather than reaching for `document` itself (the `./consent`,
 * `./pii` pattern), so both ends are asserted against a plain EventTarget without
 * a DOM.
 */

/** Document event asking the consent island to open its preferences dialog. */
export const CONSENT_PREFERENCES_EVENT = 'consent:open-preferences';

/** Ask the consent island to open the preferences dialog. */
export function openConsentPreferences(target: EventTarget): void {
  target.dispatchEvent(new CustomEvent(CONSENT_PREFERENCES_EVENT));
}

/** Open the preferences dialog whenever a control asks for it. */
export function onOpenConsentPreferences(target: EventTarget, open: () => void): void {
  target.addEventListener(CONSENT_PREFERENCES_EVENT, () => open());
}
