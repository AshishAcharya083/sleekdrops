/** Types for the plain-ESM rehype plugin in ./rehype-citations.mjs. */

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  [key: string]: unknown;
}

export function sourceAnchorId(index: number): string;
export function splitCitations(value: string, sourceCount: number): HastNode[] | null;
export function linkCitations(node: unknown, sourceCount: number): void;
// `unknown` rather than HastNode so the plugin satisfies Astro's RehypePlugin type; the
// implementation narrows as it walks.
export default function rehypeCitations(): (tree: unknown, file: unknown) => void;
