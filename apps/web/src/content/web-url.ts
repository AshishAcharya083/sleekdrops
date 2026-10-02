/**
 * Shared by the frontmatter contract and the trust vocabulary, both of which
 * render URLs they were handed as `href`s.
 */

import { z } from 'astro/zod';

/**
 * Whether a string is a URL a reader could safely be linked to.
 *
 * `z.string().url()` is not this check: it accepts `javascript:` and `data:`,
 * so a schema that only calls it hands a click-to-execute href to whatever
 * renders the field. Every source, claim, launch and badge-proof URL is
 * rendered as an `href` by a component, and most of them originate in
 * search-result text nobody controls - so the scheme is checked here rather
 * than assumed. Mirrors `isWebUrl` in the agent's content/contract.ts.
 */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export const webUrl = () => z.string().url().refine(isWebUrl, { message: 'must be an http(s) URL' });
