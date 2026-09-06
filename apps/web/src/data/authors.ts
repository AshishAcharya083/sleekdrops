/**
 * Author registry. Single source of truth for bylines, roles, bios.
 *
 * Posts reference authors by id in frontmatter (e.g. `author: mira`).
 * Add a new author here before publishing a post with their byline.
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
  /** Optional public profile link (Twitter/X, LinkedIn, personal site). */
  url?: string;
}

export const authors = {
  mira: {
    id: 'mira',
    name: 'Mira Kapoor',
    role: 'Senior reviews editor',
    bio: 'Reviews homewares and the occasional kettle. Eight years at it; still counts cable management as a feature.',
  },
  theo: {
    id: 'theo',
    name: 'Theo Renn',
    role: 'Audio & tech',
    bio: 'Spent a decade in pro audio before writing about it. Will debate Sonos vs. Sonos with you.',
  },
  aiko: {
    id: 'aiko',
    name: 'Aiko Tanaka',
    role: 'Health & wearables',
    bio: 'Logs more sleep data than is reasonable. Honest about what the numbers actually mean.',
  },
  lina: {
    id: 'lina',
    name: 'Lina Voss',
    role: 'Fashion & textiles',
    bio: 'Trained as a tailor. Cares deeply about pilling, hand-feel, and the third-wash test.',
  },
  sam: {
    id: 'sam',
    name: 'Sam Ortiz',
    role: 'Personal finance',
    bio: "Reads the fine print so you don't. Used to model cashback economics for a fintech.",
  },
  beatriz: {
    id: 'beatriz',
    name: 'Beatriz Lima',
    role: 'Travel & gear',
    bio: 'Forty flights a year. Cares about what survives a real airport, not what a kitchen scale says.',
  },
} as const satisfies Record<string, Author>;

export type AuthorId = keyof typeof authors;

export function getAuthor(id: string): Author {
  const author = (authors as Record<string, Author>)[id];
  if (!author) {
    throw new Error(`Unknown author id: "${id}". Add them to src/data/authors.ts.`);
  }
  return author;
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
