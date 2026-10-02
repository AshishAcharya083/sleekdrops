// The SLE-139 contract types this platform is written against, copied verbatim
// from the agreed contract (section 5). Their owner (`content/catalogue.ts`) is
// not on this base yet. Once it lands, replace every import of this file with
// its and delete it: the shapes are identical, so nothing else changes.
import type { ArticleShape as LibraryShape } from '../../content/shapes.js';

export interface PostTypeDef {
  id: string;
  description: string;
}

/** The catalogue's `ArticleShape`: the library record with a free id and its one-liner. */
export type CatalogueShape = Omit<LibraryShape, 'id'> & { id: string; description: string };
