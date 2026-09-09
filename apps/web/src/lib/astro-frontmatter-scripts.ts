/**
 * Script tag markers written into a `.astro` file's frontmatter - the defect
 * that hard-failed `astro dev` on every start in v0.10.0.
 *
 * Vite's dependency scanner counts `.astro` as an HTML type and lifts script
 * blocks out of the raw file with a regex, before anything has parsed it. It
 * strips HTML comments first, but a JSDoc comment in frontmatter is only text
 * to it, so a `<script>` written in prose opens a block that runs to the next
 * literal closing tag - through the rest of the comment, the Props interface,
 * the component logic and the markup. That span is handed to esbuild as a
 * TypeScript module, it cannot parse, and the scan aborts for the whole
 * project: `astro dev` prints a hard error on every start and pre-bundles
 * nothing.
 *
 * Nothing catches it on the way in. The Astro compiler itself reads the file
 * correctly - only the scanner is fooled - so `astro build` and `astro check`
 * stay green and the defect reaches a release, which is what happened here.
 *
 * A real script element can never live in frontmatter, so a marker found there
 * is a mistake whatever it was meant to say, and the rule needs no exceptions.
 * `astro-frontmatter-scripts.test.ts` runs this over every `.astro` file in the
 * tree. Markers inside the template are left to the compiler, which is the only
 * thing that can tell a real element from a mention of one.
 */

/** A script tag marker found in frontmatter, located for the failure message. */
export interface FrontmatterScriptMarker {
  /** The marker as written, e.g. `<script` or `</script`. */
  readonly marker: string;
  /** 1-based line within the whole file, so the report points at the source. */
  readonly line: number;
}

/* Case-insensitive and attribute-agnostic, because the scanner's own pattern is
   both: `<script is:inline>` and `<SCRIPT>` open a block just as `<script>`
   does. The word boundary keeps prose like `scripting` or a `scripts/` path
   out of it. */
const SCRIPT_MARKER = /<\/?script\b/gi;

const FENCE = /^---\s*$/;

const countLineBreaks = (text: string): number => text.split('\n').length - 1;

interface Frontmatter {
  readonly body: string;
  /** 1-based line the body starts on, for turning body offsets into file lines. */
  readonly startLine: number;
}

/**
 * The frontmatter body, or null when the file has none. Astro takes the fence
 * as the first thing in the file, and an unterminated one is not frontmatter.
 */
function frontmatterOf(source: string): Frontmatter | null {
  const lines = source.split('\n');
  const open = lines.findIndex((line) => line.trim().length > 0);
  if (open === -1 || !FENCE.test(lines[open])) return null;
  const close = lines.findIndex((line, index) => index > open && FENCE.test(line));
  if (close === -1) return null;
  return { body: lines.slice(open + 1, close).join('\n'), startLine: open + 2 };
}

/** Every script tag marker in the frontmatter of one `.astro` source file. */
export function findFrontmatterScriptMarkers(source: string): FrontmatterScriptMarker[] {
  const frontmatter = frontmatterOf(source);
  if (!frontmatter) return [];

  return [...frontmatter.body.matchAll(SCRIPT_MARKER)].map((match) => ({
    marker: match[0],
    line: frontmatter.startLine + countLineBreaks(frontmatter.body.slice(0, match.index)),
  }));
}
