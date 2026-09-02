/**
 * The browser's own privacy signal - Global Privacy Control, or the older
 * Do-Not-Track header exposed on `navigator`.
 *
 * A module of its own because it is read by every consumer of the consent gate,
 * not just the analytics one: `./analytics` resolves the analytics category with
 * it and `./ads` resolves the advertising category with it, and neither should
 * have to import the other to ask the same question of the same browser. Keeping
 * it out of `./consent` leaves that module's decision table pure and DOM-free.
 */

/** True when the browser is signalling Global Privacy Control or Do-Not-Track. */
export function hasPrivacySignal(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  const dnt =
    nav.doNotTrack ??
    (typeof window !== 'undefined'
      ? (window as Window & { doNotTrack?: string }).doNotTrack
      : undefined);
  return dnt === '1' || dnt === 'yes';
}
