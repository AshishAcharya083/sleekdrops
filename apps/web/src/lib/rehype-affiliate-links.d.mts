/** Types for the plain-ESM rehype plugin in ./rehype-affiliate-links.mjs. */

export interface HastProperties {
  href?: unknown;
  rel?: unknown;
  [key: string]: unknown;
}

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: HastProperties;
  children?: HastNode[];
  [key: string]: unknown;
}

export function markAffiliateAnchor(properties: HastProperties): void;
export function isAffiliateAnchor(node: unknown): node is HastNode & { properties: HastProperties };
// `unknown` rather than HastNode so the plugin satisfies Astro's RehypePlugin type; the
// implementation narrows as it walks.
export default function rehypeAffiliateLinks(): (tree: unknown) => void;
