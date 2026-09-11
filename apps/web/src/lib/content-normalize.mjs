/**
 * Normalize legacy Markdown at the D1 boundary without mutating the source row.
 * The page template owns the article H1, so an H1 inside the stored body would
 * create a second primary heading. Fenced code is left byte-for-byte alone.
 */
const LEGACY_SOURCE_REDIRECTS = new Map([
  [
    'https://www.soundcore.com/au/products/soundcore-2',
    'https://www.soundcore.com/products/soundcore-2',
  ],
]);

export function normalizeArticleBody(markdown) {
  let inFence = false;
  const normalizedHeadings = String(markdown)
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return !inFence && /^#\s+/.test(line) ? `#${line}` : line;
    })
    .join('\n');

  return [...LEGACY_SOURCE_REDIRECTS].reduce(
    (body, [staleUrl, currentUrl]) => body.replaceAll(staleUrl, currentUrl),
    normalizedHeadings,
  );
}
