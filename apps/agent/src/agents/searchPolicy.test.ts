// Which stages may open the web, asserted against the agents themselves.
//
// This is a source-level test on purpose. The rule it protects is editorial,
// not mechanical: research and review verify facts, and the writer and editor
// then work from what those two confirmed. A writer that could search would
// pull in sources nobody reviewed and reach for the competing articles sitting
// at the top of every result page — the pages this piece has to beat, not
// echo. Nothing in the type system stops someone adding `search: true` to
// writer.ts one afternoon, so this does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** The fact-checking stages, and the reason each one is trusted with the tool. */
const MAY_SEARCH: Record<string, string> = {
  'topicScout.ts': 'confirms a trend is current before the pipeline spends on it',
  'researcher.ts': 'verifies every price and spec before it enters the dossier',
  'seoReviewer.ts': 'fact-checks the draft against primary sources',
};

const SEARCH_ENABLED = /\bsearch:\s*true\b/;

function agentSources(): Array<{ file: string; source: string }> {
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(AGENTS_DIR, file), 'utf8') }));
}

test('only the fact-checking stages open the web', () => {
  for (const { file, source } of agentSources()) {
    const searches = SEARCH_ENABLED.test(source);
    if (file in MAY_SEARCH) continue;
    assert.equal(
      searches,
      false,
      `${file} passes search: true. Only the verifying stages may — ` +
        `${Object.keys(MAY_SEARCH).join(', ')}. A stage that writes prose must ` +
        `work from the dossier, or unreviewed sources reach the published piece.`,
    );
  }
});

test('every stage trusted with the tool actually uses it', () => {
  // The other half of the rule: a verifying stage that quietly stopped
  // searching would leave the pipeline with nothing checking its facts.
  const sources = new Map(agentSources().map(({ file, source }) => [file, source]));
  for (const [file, why] of Object.entries(MAY_SEARCH)) {
    const source = sources.get(file);
    assert.ok(source, `${file} is listed as a verifying stage but does not exist`);
    assert.ok(SEARCH_ENABLED.test(source), `${file} no longer searches, but it ${why}`);
    assert.match(
      source,
      /VERIFICATION_RULES/,
      `${file} has the tool but not the rules telling it what to check`,
    );
  }
});

test('the writer and the editor are told where facts may come from', () => {
  // Search discipline is only half of it — the prose stages still have to be
  // told not to cite or mirror a competing article they already have in hand.
  for (const file of ['writer.ts', 'editor.ts', 'outliner.ts']) {
    const source = readFileSync(join(AGENTS_DIR, file), 'utf8');
    assert.match(source, /SOURCE_DISCIPLINE/, `${file} does not carry the source rules`);
  }
});
