// The site's two editions. Mirrors apps/agent/src/platform/peakodds/index.ts
// (peakoddsSeed.editions): the agent decides which edition a post belongs to
// and this file decides where the site shows it, so the ids, names, time
// zones and locales must agree. editions.test.ts and the agent's
// peakodds.test.ts assert the same literals.

export type EditionId = 'au' | 'global';

export interface Edition {
  readonly id: EditionId;
  readonly name: string;
  readonly timeZone: string;
  readonly locale: string;
}

export const EDITIONS: readonly Edition[] = [
  { id: 'au', name: 'Australia', timeZone: 'Australia/Sydney', locale: 'en-AU' },
  { id: 'global', name: 'Global', timeZone: 'UTC', locale: 'en-GB' },
];

export function isEditionId(value: string): value is EditionId {
  return EDITIONS.some((edition) => edition.id === value);
}

export function getEdition(id: EditionId): Edition {
  const edition = EDITIONS.find((candidate) => candidate.id === id);
  if (!edition) throw new Error(`Unknown PeakOdds edition '${id}'`);
  return edition;
}

/** '/au', '/au/afl', '/au/afl/round-12'. Each segment is used as given, with no trailing slash. */
export function editionHref(editionId: EditionId, ...segments: string[]): string {
  return `/${[editionId, ...segments].join('/')}`;
}
