/**
 * rehype plugin: mark every affiliate link the markdown body carries.
 *
 * Article bodies link products as `[text](/go/<slug>)`, and the redirect behind
 * that path is a paid placement in Google's terms. Google asks for
 * `rel="sponsored"` on exactly those links, and because `/go/` is disallowed in
 * robots.txt the attribute on the anchor is the only signal a crawler ever sees
 * about them. The CTA components already set it; the body links, which are the
 * majority, did not - this plugin closes that gap at render time so no author or
 * pipeline rule has to remember it.
 *
 * `noopener` rides along for the usual reason. `noreferrer` deliberately does
 * not: Amazon's Program Policies (§6(v)) require that Amazon can determine the
 * site a click came from, and a `noreferrer` link strips the Referer that tells
 * them. The page's Referrer-Policy already reduces it to the origin.
 *
 * Plain ESM with no unist dependency so `astro.config.mjs` can import it and the
 * node test runner can exercise it without a build.
 */

/** Anchors whose href is a first-party affiliate redirect. */
const GO_HREF = /^\/go\/[^/?#]+/;

const REQUIRED_REL = ['sponsored', 'noopener'];

/** `rel` as an array, whatever shape rehype handed us (space-separated string or list). */
function relTokens(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

/** Add the required tokens to an anchor's `rel`, preserving whatever was there. */
export function markAffiliateAnchor(properties) {
  const tokens = relTokens(properties.rel);
  for (const token of REQUIRED_REL) {
    if (!tokens.includes(token)) tokens.push(token);
  }
  properties.rel = tokens;
}

/** True for an `<a>` whose href points at `/go/<slug>`. */
export function isAffiliateAnchor(node) {
  if (!node || node.type !== 'element' || node.tagName !== 'a') return false;
  const href = node.properties?.href;
  return typeof href === 'string' && GO_HREF.test(href);
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const children = node.children;
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit));
}

/** The plugin. Usage in astro.config.mjs: `rehypePlugins: [rehypeAffiliateLinks]`. */
export default function rehypeAffiliateLinks() {
  return (tree) => {
    walk(tree, (node) => {
      if (isAffiliateAnchor(node)) markAffiliateAnchor(node.properties);
    });
  };
}
