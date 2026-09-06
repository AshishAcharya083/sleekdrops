/**
 * Anchor integrity - the rule that an in-page link must have something to land
 * on, enforced against the built HTML rather than against the data that
 * happened to be populated at the time.
 *
 * `scripts/check-anchors.mjs` walks `dist/` and fails the build on anything this
 * module reports, so a page can never ship an `href="#foo"` with no `id="foo"`.
 * The parsing is deliberately regex-level: the input is Astro's own generated
 * markup, and pulling in a DOM parser to read it would be the heavier answer to
 * a check that only needs two attribute sets.
 */

/** An in-page link whose target does not exist in the same document. */
export interface BrokenAnchor {
  /** The href as authored, e.g. `#today`. */
  readonly href: string;
  /** The fragment it points at, decoded. */
  readonly id: string;
}

/* Astro always emits double-quoted attributes, but `public/` ships hand-written
   HTML straight through, so both quote styles are read rather than leaving one
   of them silently unchecked. */
const HREF_PATTERN = /\shref\s*=\s*(["'])(#[^"']*)\1/gi;
const ID_PATTERN = /\sid\s*=\s*(["'])([^"']*)\1/gi;
const NAME_PATTERN = /<a\b[^>]*?\sname\s*=\s*(["'])([^"']*)\1/gi;

function decodeFragment(raw: string): string {
  const withEntities = raw
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  try {
    return decodeURIComponent(withEntities);
  } catch {
    return withEntities;
  }
}

function collect(html: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(pattern)) {
    if (match[2]) found.add(decodeFragment(match[2]));
  }
  return found;
}

/**
 * Every in-page reference in `html` with no matching target - anchor CTAs, TOC
 * links and SVG `<use href="#...">` alike, since all three render as nothing
 * when the id is absent. `href="#"` and `href="#top"` are the browser's own
 * "scroll to top" behaviour and need no element, so they are not reported.
 */
export function findBrokenAnchors(html: string): BrokenAnchor[] {
  const targets = collect(html, ID_PATTERN);
  for (const name of collect(html, NAME_PATTERN)) targets.add(name);

  const broken = new Map<string, BrokenAnchor>();
  for (const match of html.matchAll(HREF_PATTERN)) {
    const href = match[2] ?? '';
    const id = decodeFragment(href.slice(1));
    if (id === '' || id.toLowerCase() === 'top') continue;
    if (targets.has(id)) continue;
    broken.set(href, { href, id });
  }
  return [...broken.values()];
}
