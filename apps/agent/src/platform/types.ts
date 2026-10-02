// The shape of a platform (one brand the pipeline writes for) and its editions
// (the audiences it writes each piece for). The rows live in the `platforms`
// and `editions` tables; src/platform/<id>/ holds each brand's seed profile.

export const MONETISATION_MODES = ['amazon', 'none'] as const;

/** 'amazon' earns through Amazon affiliate go-links; 'none' carries no offers or go-links at all. */
export type MonetisationMode = (typeof MONETISATION_MODES)[number];

/**
 * Where a platform publishes, as the NAMES of the environment variables that
 * hold each value. A secret never enters the database: the publisher reads
 * the variable named here at publish time.
 */
export interface PublishTarget {
  d1DatabaseIdEnv: string;
  /** The credential that fires the site rebuild. */
  rebuildHookEnv: string;
  siteUrlEnv: string;
  githubRepoEnv: string;
}

export interface Edition {
  platformId: string;
  id: string;
  name: string;
  /** IANA zone the edition's dates and kick-off times are stated in. */
  timeZone: string;
  /** ISO 4217 code, or null for an edition that quotes no currency amounts. */
  currency: string | null;
  /** BCP 47 tag, e.g. "en-AU". */
  locale: string;
  /** Scout queries for this audience, run after the platform's own. */
  scoutQueries: string[];
  /** Appended to every article by code, never written by a model. Empty for none. */
  complianceFooter: string;
}

/** The editable profile: what a platform's prompts, formats and rules are built from. */
export interface PlatformProfile {
  id: string;
  name: string;
  brandText: string;
  audience: string;
  categories: string[];
  /** Ids from the post type catalogue this platform may produce. */
  postTypes: string[];
  /** Ids from the article shape catalogue this platform may be written in. */
  articleShapes: string[];
  editorialRules: string;
  monetisation: MonetisationMode;
  /** Domains no article may link to, subdomains included. */
  blockedLinkDomains: string[];
  scoutQueries: string[];
  /** Goal text per agent name. An agent with no entry keeps its prompt's own goal. */
  agentGoals: Record<string, string>;
  publishTarget: PublishTarget;
  editions: Edition[];
}

export interface Platform extends PlatformProfile {
  /**
   * The platform_profile_versions row the profile above is, which an article
   * records as its articles.profile_version. Null until a version is saved.
   */
  profileVersion: number | null;
}
