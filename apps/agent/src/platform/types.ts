// The shape of a platform (one brand the pipeline writes for) and its editions
// (the audiences it writes each piece for). The rows live in the `platforms`
// and `editions` tables; src/platform/<id>/ holds each brand's seed.

/** 'amazon' earns through Amazon affiliate go-links; 'none' carries no offers or go-links at all. */
export type MonetisationMode = 'amazon' | 'none';
export const MONETISATION_MODES: readonly MonetisationMode[] = ['amazon', 'none'];

/** Agent ids that may carry a goal: 'scout' plus every Stage except 'publish' | 'done'. */
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

/** A class of topic a platform does not cover - see topicRules.ts. */
export type TopicClass = 'racing';

/**
 * Where a platform publishes, as the NAMES of the environment variables that
 * hold each value. A secret never enters the database: the publisher reads
 * the variable named here at publish time.
 */
export interface PublishTargetRef {
  d1DatabaseIdEnv: string;
  githubRepoEnv: string;
  siteUrlEnv: string;
  /** null = repository_dispatch to the repo (SleekDrops today). */
  rebuildHookEnv: string | null;
}

export interface Edition {
  id: string;
  platformId: string;
  name: string;
  /** IANA, e.g. 'Australia/Sydney', 'UTC'. */
  timeZone: string;
  /** ISO 4217, or null for an edition that quotes no currency amounts. */
  currency: string | null;
  /** BCP 47, e.g. 'en-AU', 'en-GB'. */
  locale: string;
  /** Run after the platform's own scout queries. */
  scoutQueries: readonly string[];
  /** Markdown appended by the assembler, never written by a model; '' = none. */
  complianceFooter: string;
}

export interface Platform {
  id: string;
  name: string;
  bylineName: string;
  brandText: string;
  audience: string;
  categories: readonly string[];
  /** Ids into the post type catalogue. */
  postTypes: readonly string[];
  /** Ids into the article shape catalogue. */
  articleShapes: readonly string[];
  editorialRules: string;
  monetisation: MonetisationMode;
  /** Bare hostnames; a subdomain of one is blocked too. */
  blockedLinkDomains: readonly string[];
  blockedTopics: readonly TopicClass[];
  scoutQueries: readonly string[];
  /** An agent with no entry keeps the goal its own prompt states. */
  agentGoals: Readonly<Partial<Record<AgentId, string>>>;
  publishTarget: PublishTargetRef;
  /** platform_profile_versions.id currently in force. */
  profileVersion: number;
  editions: readonly Edition[];
}

/** The in-code shape a platform seeds from (platform/<id>/ exports one). */
export interface PlatformSeed {
  platform: Omit<Platform, 'profileVersion' | 'editions'>;
  editions: readonly Omit<Edition, 'platformId'>[];
}
