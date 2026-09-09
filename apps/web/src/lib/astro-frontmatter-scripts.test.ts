/**
 * The guard against the v0.10.0 dev-server failure: a script tag marker in a
 * `.astro` file's frontmatter.
 *
 * The unit cases pin the rule (frontmatter yes, template no, comments and
 * strings included), and the last test is the one that actually protects the
 * repo - it walks every `.astro` file in `src/` and asserts the tree is clean,
 * so the defect cannot come back through a component nobody thought to check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFrontmatterScriptMarkers } from './astro-frontmatter-scripts.ts';

const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Every `.astro` file under `src/`, in walk order. */
function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.isFile() && entry.name.endsWith('.astro') ? [path] : [];
  });
}

test('the shipped defect is reported: a script tag inside a frontmatter comment', () => {
  const source = [
    '---',
    "import JsonLd from './JsonLd.astro';",
    '',
    '/**',
    " * separate <script> blocks are what Google's own docs recommend",
    ' */',
    '---',
    '<div />',
  ].join('\n');

  assert.deepEqual(findFrontmatterScriptMarkers(source), [{ marker: '<script', line: 5 }]);
});

test('a real script element in the template is left alone', () => {
  const source = ['---', 'const theme = 1;', '---', '<script is:inline>', 'run();', '</script>'].join(
    '\n',
  );

  assert.deepEqual(findFrontmatterScriptMarkers(source), []);
});

test('a marker in a frontmatter string literal counts too', () => {
  // The scanner regexes the raw file, so quoting is no more of an escape than
  // commenting is.
  const source = ['---', "const tag = '<script>';", '---', '<div />'].join('\n');

  assert.deepEqual(findFrontmatterScriptMarkers(source), [{ marker: '<script', line: 2 }]);
});

test('casing, attributes and closing tags are all markers', () => {
  const source = ['---', '// <SCRIPT type="module"> and </script>', '---', '<div />'].join('\n');

  assert.deepEqual(findFrontmatterScriptMarkers(source), [
    { marker: '<SCRIPT', line: 2 },
    { marker: '</script', line: 2 },
  ]);
});

test('prose that merely contains the word is not a marker', () => {
  const source = ['---', "// scripts/chrome.ts does the scripting, no <scriptish/> tag", '---'].join(
    '\n',
  );

  assert.deepEqual(findFrontmatterScriptMarkers(source), []);
});

test('a file with no frontmatter, or an unterminated fence, reports nothing', () => {
  assert.deepEqual(findFrontmatterScriptMarkers('<div>plain markup</div>'), []);
  assert.deepEqual(findFrontmatterScriptMarkers('---\n// <script> and no closing fence\n'), []);
});

test('a fence after leading blank lines is still read as frontmatter', () => {
  assert.deepEqual(findFrontmatterScriptMarkers('\n\n---\n// <script>\n---\n<div />'), [
    { marker: '<script', line: 4 },
  ]);
});

test('the line number points at the offending line, not the first one', () => {
  const source = ['---', 'const a = 1;', '', '// <script>', '---'].join('\n');

  assert.deepEqual(findFrontmatterScriptMarkers(source), [{ marker: '<script', line: 4 }]);
});

test('no .astro file in src/ carries a script tag marker in its frontmatter', () => {
  const files = astroFiles(srcDir);
  assert.ok(files.length > 40, `expected the component tree, walked ${files.length} files`);

  const offenders = files.flatMap((path) =>
    findFrontmatterScriptMarkers(readFileSync(path, 'utf8')).map(
      ({ marker, line }) => `${relative(srcDir, path)}:${line} has \`${marker}\``,
    ),
  );

  assert.deepEqual(
    offenders,
    [],
    `script tag markers in .astro frontmatter break \`astro dev\`:\n${offenders.join('\n')}`,
  );
});
