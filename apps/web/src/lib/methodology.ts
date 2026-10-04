/**
 * The /how-we-rate methodology surface every other page links into.
 *
 * Owned by SLE-147. This is an interim copy of the frozen contract exports that
 * SLE-148's score explainer consumes, so its branch builds before SLE-147
 * lands; SLE-147's module replaces it wholesale on restack.
 */

import type { MethodVersion } from './trust.ts';

export const METHODOLOGY_PATH = '/how-we-rate';

export type MethodologySection =
  | 'bands'
  | 'distribution'
  | 'assessment'
  | 'changelog'
  | 'badges'
  | 'independence'
  | 'corrections'
  | 'categories';

export function methodologyHref(section?: MethodologySection): string {
  return section ? `${METHODOLOGY_PATH}#${section}` : METHODOLOGY_PATH;
}

/** The changelog entry for a method version: `1.0` -> `/how-we-rate#method-v1-0`. */
export function methodVersionHref(version: MethodVersion): string {
  return `${METHODOLOGY_PATH}#method-v${version.replace(/\./g, '-')}`;
}

export const PAID_LINK_NOTE =
  'Paid link. We may earn a commission if you buy. It never affects the score.';
