/** Types for the plain-ESM crawl policy in ./robots-policy.mjs. */

export const DISALLOWED_PATHS: string[];

export interface AiAgentGroup {
  /** Who operates the agents, used as the comment above their User-agent lines. */
  operator: string;
  /** The product tokens they send, exactly as robots.txt must spell them. */
  tokens: string[];
}

export const AI_AGENT_GROUPS: AiAgentGroup[];
export const AI_AGENT_TOKENS: string[];

export interface RobotsInput {
  deployment: 'production' | 'preview';
  siteUrl: string;
  hasContentMap?: boolean;
  marker?: string;
}

export function buildRobotsTxt(input: RobotsInput): string;

export interface CrawlRule {
  allow: boolean;
  path: string;
}

export interface MatchedRules {
  /** The agent token whose group applies, `*` for the wildcard, null for none. */
  token: string | null;
  rules: CrawlRule[];
}

export function matchRules(robotsTxt: string, userAgent: string): MatchedRules;
export function isAllowed(robotsTxt: string, userAgent: string, path: string): boolean;
