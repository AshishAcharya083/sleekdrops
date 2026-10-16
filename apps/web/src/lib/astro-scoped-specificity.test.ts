/**
 * The guard against a modifier a scoped style block has already lost: the
 * defect that drew every evidence-panel tier swatch in the same grey.
 *
 * The unit cases pin the rule (the shipped defect, the two shapes of modifier,
 * the cases that are deliberately fine), and the last test is the one that
 * protects the repo - it walks every `.astro` file in `src/` and asserts the
 * tree is clean, so the next component cannot reintroduce it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findDeadModifiers } from './astro-scoped-specificity.ts';

const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Every `.astro` file under `src/`, in walk order. */
function astroFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return astroFiles(path);
    return entry.isFile() && entry.name.endsWith('.astro') ? [path] : [];
  });
}

const style = (css: string): string => `---\nconst a = 1;\n---\n<div />\n<style>\n${css}\n</style>`;

test('the shipped defect is reported: a descendant base against a modifier', () => {
  const source = style(
    `.tier-legend-row .legend-rule { border-top: 3px solid var(--hairline-strong); }
     .legend-rule.legend-rule--expert { border-top: 3px solid var(--ink); }`,
  );

  assert.deepEqual(findDeadModifiers(source), [
    {
      modifier: '.legend-rule.legend-rule--expert',
      base: '.tier-legend-row .legend-rule',
      properties: ['border-top'],
    },
  ]);
});

test('the flat base rule the fix uses reports nothing', () => {
  const source = style(
    `.legend-rule { border-top: 3px solid var(--hairline-strong); }
     .legend-rule.legend-rule--expert { border-top: 3px solid var(--ink); }`,
  );

  assert.deepEqual(findDeadModifiers(source), []);
});

test('a bare modifier against an equally specific base is left alone', () => {
  // Equal weight, and the modifier is written after its base - source order
  // decides it, which is the ordinary way every component here is written.
  const source = style(
    `.provenance { border-left: 3px solid var(--ink); }
     .provenance--loan { border-left-color: var(--warning); }`,
  );

  assert.deepEqual(findDeadModifiers(source), []);
});

test('a shorthand base beats a longhand modifier, and says which property', () => {
  const source = style(
    `.card-grid .card { border: 1px solid var(--hairline); }
     .card--flagged { border-color: var(--warning); }`,
  );

  assert.deepEqual(findDeadModifiers(source), [
    { modifier: '.card--flagged', base: '.card-grid .card', properties: ['border'] },
  ]);
});

test('a base that sets nothing the modifier touches is not a conflict', () => {
  const source = style(
    `.pick-grid .pick-card { padding: 20px; }
     .pick-card--tested { background: var(--surface-2); }`,
  );

  assert.deepEqual(findDeadModifiers(source), []);
});

test('a descendant rule scoped to the modifier itself is not the modifier', () => {
  // `.claim-card--context .claim-chip` styles a child, not the block, and its
  // weight is supposed to be higher.
  const source = style(
    `.claim-chip { color: var(--ink); }
     .claim-card--context .claim-chip { color: var(--muted); }`,
  );

  assert.deepEqual(findDeadModifiers(source), []);
});

test('a base that wins with the value the modifier wanted is not a defect', () => {
  // AdUnit's pre-consent rule, in miniature: both say `display: none`, so the
  // modifier losing changes nothing a reader could see.
  const source = style(
    `.ad-unit[hidden] { display: none; }
     .ad-unit--sidebar { display: none; }`,
  );

  assert.deepEqual(findDeadModifiers(source), []);
});

test('a file with no style block, or no modifiers, reports nothing', () => {
  assert.deepEqual(findDeadModifiers('---\nconst a = 1;\n---\n<div />'), []);
  assert.deepEqual(findDeadModifiers(style('.plain { color: red; }')), []);
});

test('no .astro file in src/ carries a modifier its own base rule out-specifies', () => {
  const files = astroFiles(srcDir);
  assert.ok(files.length > 40, `expected the component tree, walked ${files.length} files`);

  const offenders = files.flatMap((path) =>
    findDeadModifiers(readFileSync(path, 'utf8')).map(
      ({ modifier, base, properties }) =>
        `${relative(srcDir, path)}: \`${modifier}\` cannot set ${properties.join(', ')} - ` +
        `\`${base}\` out-specifies it once Astro scopes them`,
    ),
  );

  assert.deepEqual(
    offenders,
    [],
    `scoped modifiers that never apply:\n${offenders.join('\n')}`,
  );
});
