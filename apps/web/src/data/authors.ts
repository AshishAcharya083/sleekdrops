/**
 * Public byline registry.
 *
 * Older D1 posts retain their original internal author ids. `getAuthor` maps
 * those ids to the single public desk identity so old URLs keep rendering
 * while readers see one accurate, accountable byline.
 */

export interface Author {
  id: string;
  name: string;
  /** Role / title shown next to the byline. */
  role: string;
  /** One-line bio for the article footer / author page. */
  bio: string;
  /** Optional initials override; defaults to first letters of name. */
  initials?: string;
  /** Optional public profile link. */
  url?: string;
}

export const authors = {
  desk: {
    id: 'desk',
    name: 'SleekDrops Editorial Desk',
    role: 'Editorial team',
    bio: 'Researches products, prices and published evidence for Australian shoppers. Each recommendation states what we checked and when we have not tested a product ourselves.',
    initials: 'SD',
  },
} as const satisfies Record<string, Author>;

export type AuthorId = keyof typeof authors;

const LEGACY_AUTHOR_IDS = new Set(['mira', 'theo', 'aiko', 'lina', 'sam', 'beatriz']);

export function getAuthor(id: string): Author {
  if (id === 'desk' || LEGACY_AUTHOR_IDS.has(id)) return authors.desk;
  throw new Error(`Unknown author id: "${id}". Add it to src/data/authors.ts.`);
}

export function listAuthors(): Author[] {
  return Object.values(authors);
}

export function authorInitials(author: Author): string {
  if (author.initials) return author.initials;
  return author.name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
