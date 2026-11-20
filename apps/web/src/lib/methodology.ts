/**
 * The /how-we-rate methodology surface every other page links into.
 *
 * Owned by SLE-147. This is an interim copy of the frozen contract exports that
 * SLE-151 consumes, so its branch builds before SLE-147 lands; SLE-147's module
 * replaces it wholesale on restack.
 */

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

export const PAID_LINK_NOTE =
  'Paid link. We may earn a commission if you buy. It never affects the score.';

export const ASSESSMENT_SUMMARY =
  'SleekDrops reviews are researched, not hands-on. Unless a review says otherwise, nobody here handled the product: it was assessed from published specifications, independent test results and owner reports, compared against its nearest competitors, and every source is listed with its publisher and date.';

export const INDEPENDENCE_MECHANISM: readonly string[] = [
  'We publish no sponsored posts, and no brand pays for a place on SleekDrops.',
  'Writers never see commission rates, so what a retailer pays cannot shape what is written.',
  'No brand, retailer or affiliate network can change a published score.',
  'We link the best retailer for the reader, even where it runs no affiliate program and we earn nothing.',
];
