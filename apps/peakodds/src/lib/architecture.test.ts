// The PeakOdds site is a gambling site, so nothing from SleekDrops' apps - its
// affiliate links, go-links, ads and sponsored-link rules above all - may
// reach it. Apps share no code by import ([repo.app-boundaries]); this test
// holds apps/peakodds to that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(THIS_FILE), '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js', '.astro']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.astro', '.content-cache', '.wrangler']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const WORKSPACE_PACKAGE = /^@sleekdrops\//;

/** The import specifiers in `source` that reach outside apps/peakodds, for a file at `file`. */
function importsLeavingApp(file: string, source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => {
      if (WORKSPACE_PACKAGE.test(specifier)) return true;
      if (/(?:^|\/)apps\//.test(specifier)) return true;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
      const target = resolve(dirname(file), specifier);
      return target !== APP_ROOT && !target.startsWith(APP_ROOT + sep);
    });
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
      return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

test('no PeakOdds module imports from another app', async () => {
  // This file is left out: its examples below are imports of other apps.
  const files = (await sourceFiles(APP_ROOT)).filter((file) => file !== THIS_FILE);
  assert.ok(files.length > 0, 'found no source files to check');
  const leaks = (
    await Promise.all(
      files.map(async (file) =>
        importsLeavingApp(file, await readFile(file, 'utf8')).map(
          (specifier) => `${relative(APP_ROOT, file)} imports ${specifier}`,
        ),
      ),
    )
  ).flat();
  assert.deepEqual(leaks, []);
});

test('an import of another app is caught however it is written', () => {
  const file = join(APP_ROOT, 'src/pages/[edition]/index.astro');
  assert.deepEqual(
    importsLeavingApp(
      file,
      [
        "import Verdict from '../../../../web/src/components/article/Verdict.astro';",
        "import { goHref } from '@sleekdrops/web/src/lib/affiliates';",
        "const ads = await import('../../../../web/src/lib/ads.ts');",
        "import '/home/dev/sleekdrops/apps/web/src/styles/global.css';",
        "import { getEditionPosts } from '@lib/posts';",
        "import { EDITIONS } from '../../data/editions.ts';",
        "import { createMarkdownProcessor } from '@astrojs/markdown-remark';",
      ].join('\n'),
    ),
    [
      '../../../../web/src/components/article/Verdict.astro',
      '@sleekdrops/web/src/lib/affiliates',
      '../../../../web/src/lib/ads.ts',
      '/home/dev/sleekdrops/apps/web/src/styles/global.css',
    ],
  );
});
