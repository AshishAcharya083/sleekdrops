// The code-level catalogue of post types and article shapes. Formats are code:
// what a post type means and how a shape is structured are output contracts
// the pipeline enforces, so they live here rather than in a platform's
// editable profile. What a platform owns is the choice - platform.postTypes
// and platform.articleShapes are ids into these lists, in the order that
// platform wants them offered.
import { LIBRARY_SHAPES } from './shapeLibrary.js';
import { PEAKODDS_POST_TYPES, PEAKODDS_SHAPES } from '../platform/peakodds/formats.js';
import type { ArticleShape } from './shapes.js';
import type { Platform } from '../platform/types.js';

/** One post type the pipeline can write. */
export interface PostTypeDef {
  id: string;
  /** What the type is and the bar it has to clear - the bullet printed in siteContext. */
  description: string;
}

// `review` is deliberately absent: reviews require hands-on testing and are
// human-driven per the editorial rules. The pipeline writes the others.
export const POST_TYPE_CATALOGUE: readonly PostTypeDef[] = [
  { id: 'article', description: 'news/trend piece, no length minimum, still evidence-based.' },
  {
    id: 'guide',
    description: '"best X for Y" buying guide, at least 1,500 words, at least 3 contenders.',
  },
  { id: 'roundup', description: '"Top N" listicle with clear scoring rationale.' },
  ...PEAKODDS_POST_TYPES,
];

export const SHAPE_CATALOGUE: readonly ArticleShape[] = [...LIBRARY_SHAPES, ...PEAKODDS_SHAPES];

/** The catalogue entry for every id, looked up in the order the platform lists them. */
function select<T extends { id: string }>(
  catalogue: readonly T[],
  ids: readonly string[],
  what: string,
  platform: Platform,
): T[] {
  return ids.map((id) => {
    const entry = catalogue.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`platform ${platform.id} selects ${what} "${id}", which is not in the catalogue`);
    }
    return { ...entry };
  });
}

/** The post types this platform publishes, in platform order. */
export function getPostTypes(platform: Platform): PostTypeDef[] {
  return select(POST_TYPE_CATALOGUE, platform.postTypes, 'post type', platform);
}

/** The article shapes this platform publishes, in platform order. */
export function getArticleShapes(platform: Platform): ArticleShape[] {
  return select(SHAPE_CATALOGUE, platform.articleShapes, 'article shape', platform);
}

/**
 * A shape in the catalogue. Ids come out of a model and out of JSONB columns,
 * so nothing is assumed: an exact id match, never an `in` check, because
 * `'constructor' in {}` is true.
 */
export function isCatalogueShape(id: unknown): id is string {
  return typeof id === 'string' && SHAPE_CATALOGUE.some((shape) => shape.id === id);
}

/** The catalogue entry for an id, or null when the id is not one we publish. */
export function shapeById(id: unknown): ArticleShape | null {
  const shape = SHAPE_CATALOGUE.find((candidate) => candidate.id === id);
  return shape ? { ...shape } : null;
}
