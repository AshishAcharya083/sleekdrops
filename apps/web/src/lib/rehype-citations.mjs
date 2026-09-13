/**
 * rehype plugin: turn the body's bracketed citation markers into links to the
 * article's sources block.
 *
 * The pipeline's writer attributes a claim by appending the marker of the
 * source it came from - "RTINGS measured 28.5 hours in 2026.[3]" - numbered
 * against the same list the assembler wrote into `frontmatter.sources` and the
 * page renders under "Sources". This plugin is the only place that numbering
 * becomes navigable: `[3]` becomes a superscript link to `#source-3`, which is
 * the id the third row of that block carries.
 *
 * A marker is only converted when the post actually carries that source, so a
 * link is never emitted for an anchor the page does not render (which
 * `scripts/check-anchors.mjs` would fail the build over, rightly). Anything
 * else that looks like a marker - a link reference, a number in a code sample -
 * is left exactly as the author wrote it.
 *
 * Plain ESM with no unist dependency so `astro.config.mjs` can import it and the
 * node test runner can exercise it without a build.
 */

/**
 * A bracketed marker: `[3]`, but never a markdown link reference (`[text][3]`,
 * `[3]: url`). Markdown link syntax has already become an `<a>` element by the
 * time this runs, so only text nodes are ever examined.
 */
const CITATION_MARKER = /\[(\d{1,3})\]/g;

/** Elements whose text is verbatim content, or already a link. */
const OPAQUE = new Set(['code', 'pre', 'a', 'kbd', 'samp', 'script', 'style']);

/** The id the nth row of the sources block carries. See Sources.astro. */
export function sourceAnchorId(index) {
  return `source-${index}`;
}

/** The hast nodes one text node becomes: its text, with markers turned into links. */
export function splitCitations(value, sourceCount) {
  const nodes = [];
  let cursor = 0;
  CITATION_MARKER.lastIndex = 0;
  for (const match of value.matchAll(CITATION_MARKER)) {
    const index = Number(match[1]);
    if (index < 1 || index > sourceCount) continue;
    const start = match.index ?? 0;
    if (start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, start) });
    nodes.push({
      type: 'element',
      tagName: 'sup',
      properties: { className: ['citation'] },
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: {
            href: `#${sourceAnchorId(index)}`,
            'aria-label': `Source ${index}`,
            'data-citation': String(index),
          },
          children: [{ type: 'text', value: `[${index}]` }],
        },
      ],
    });
    cursor = start + match[0].length;
  }
  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
}

/** Replace markers in every text node under `node`, in place. */
export function linkCitations(node, sourceCount) {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return;
  if (node.type === 'element' && OPAQUE.has(node.tagName)) return;

  const children = [];
  let changed = false;
  for (const child of node.children) {
    if (child?.type === 'text' && typeof child.value === 'string') {
      const split = splitCitations(child.value, sourceCount);
      if (split) {
        children.push(...split);
        changed = true;
        continue;
      }
    }
    children.push(child);
    linkCitations(child, sourceCount);
  }
  if (changed) node.children = children;
}

/** How many sources the post being rendered carries; 0 when it carries none. */
function sourceCountOf(file) {
  const sources = file?.data?.astro?.frontmatter?.sources;
  return Array.isArray(sources) ? sources.length : 0;
}

/** The plugin. Usage in astro.config.mjs: `rehypePlugins: [rehypeCitations]`. */
export default function rehypeCitations() {
  return (tree, file) => {
    const sourceCount = sourceCountOf(file);
    if (sourceCount > 0) linkCitations(tree, sourceCount);
  };
}
