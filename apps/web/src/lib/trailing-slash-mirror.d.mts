/** Types for the plain-ESM mirror plan in ./trailing-slash-mirror.mjs. */

export interface TrailingSlashMirror {
  /** The file the build wrote, dist-relative (`blog/xiaomi-17-ultra.html`). */
  source: string;
  /** Where its trailing-slash copy goes (`blog/xiaomi-17-ultra/index.html`). */
  mirror: string;
}

export function planTrailingSlashMirrors(htmlPaths: string[]): TrailingSlashMirror[];
