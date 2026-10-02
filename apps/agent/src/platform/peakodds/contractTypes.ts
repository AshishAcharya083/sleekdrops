// The multi-platform contract types this platform is written against, copied
// verbatim from the agreed contract (section 2 for the platform and edition,
// section 5 for the catalogue). Their owners, SLE-138 (`platform/types.ts`)
// and SLE-139 (`content/catalogue.ts`, `agents/context.ts`), were not on the
// base this card was built from. Once they land, replace every import of this
// file with theirs and delete it: the shapes are identical, so nothing else
// changes.
import type { ArticleShape as LibraryShape } from '../../content/shapes.js';

export type MonetisationMode = 'amazon' | 'none';
export type AgentId =
  | 'scout'
  | 'research'
  | 'keyword'
  | 'angle'
  | 'outline'
  | 'write'
  | 'seo_review'
  | 'edit'
  | 'assemble'
  | 'image';
export type TopicClass = 'racing';

export interface PublishTargetRef {
  d1DatabaseIdEnv: string;
  githubRepoEnv: string;
  siteUrlEnv: string;
  rebuildHookEnv: string | null;
}

export interface Edition {
  id: string;
  platformId: string;
  name: string;
  timeZone: string;
  currency: string | null;
  locale: string;
  scoutQueries: readonly string[];
  complianceFooter: string;
}

export interface Platform {
  id: string;
  name: string;
  bylineName: string;
  brandText: string;
  audience: string;
  categories: readonly string[];
  postTypes: readonly string[];
  articleShapes: readonly string[];
  editorialRules: string;
  monetisation: MonetisationMode;
  blockedLinkDomains: readonly string[];
  blockedTopics: readonly TopicClass[];
  scoutQueries: readonly string[];
  agentGoals: Readonly<Partial<Record<AgentId, string>>>;
  publishTarget: PublishTargetRef;
  profileVersion: number;
  editions: readonly Edition[];
}

export interface PlatformSeed {
  platform: Omit<Platform, 'profileVersion' | 'editions'>;
  editions: readonly Omit<Edition, 'platformId'>[];
}

export interface PromptContext {
  platform: Platform;
  edition: Edition;
}

export interface PostTypeDef {
  id: string;
  description: string;
}

/** The catalogue's `ArticleShape`: the library record with a free id and its one-liner. */
export type CatalogueShape = Omit<LibraryShape, 'id'> & { id: string; description: string };
