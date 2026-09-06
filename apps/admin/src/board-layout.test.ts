/**
 * The Pipeline board is a CSS grid of 1fr lanes, and a 1fr track is floored at
 * its content's min-content width - so one article whose title or error has no
 * spaces (a token like CLAUDE_CODE_OAUTH_TOKEN is enough) widened the board to
 * ~1010px and slid the whole panel sideways at 390px, the symptom the topbar
 * and table fixes already removed everywhere else. The panel has no layout
 * harness (this was measured in Chromium at 320-1440px against the built panel
 * served by the agent API), so this guards the declarations and the markup
 * that let a lane shrink and its text wrap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const styles = read('./styles.css');
const pipeline = read('./pages/Pipeline.tsx');

function rule(selector: string, source = styles): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `styles.css no longer has a ${selector} rule`);
  return match[1];
}

/**
 * The winning value of `property` for `selector` at a given viewport width:
 * every declaration in force there, in document order, last one wins - the
 * cascade for same-specificity rules, which is what decides the lane count.
 */
function declarationAt(width: number, selector: string, property: string): string {
  const inForce = styles.replace(/@media \(max-width:\s*(\d+)px\)\s*\{(.*?\})\s*\}/gs, (block, max: string, body: string) =>
    Number(max) >= width ? body : '',
  );
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*?\\b${property}:\\s*([^;}]+)`,
    'g',
  );
  const values = [...inForce.matchAll(pattern)].map((m) => m[1].trim());
  assert.ok(values.length > 0, `styles.css declares no ${property} for ${selector} at ${width}px`);
  return values[values.length - 1];
}

test('a lane shrinks with its track instead of pushing it wider', () => {
  assert.match(rule('.lane'), /min-width:\s*0/, 'a 1fr track only shrinks if the grid item may');
  assert.match(
    rule('.cardlet'),
    /overflow-wrap:\s*anywhere/,
    'an unbroken title or error must break; break-word would still set the min-content width',
  );
});

test('the lanes stack single-column on a phone', () => {
  assert.equal(declarationAt(390, '.board', 'grid-template-columns'), '1fr', 'four lanes do not fit at 390px');
  assert.equal(declarationAt(1440, '.board', 'grid-template-columns'), 'repeat(4, 1fr)', 'the desktop board is four lanes');
});

test('the board markup adds no width of its own', () => {
  const errorPreview = pipeline.indexOf('className="err"');
  assert.notEqual(errorPreview, -1, 'Pipeline.tsx no longer renders the error preview');
  assert.notEqual(
    pipeline.slice(0, errorPreview).lastIndexOf('className="cardlet"'),
    -1,
    'the error preview must sit inside .cardlet to inherit its wrapping',
  );
  const board = pipeline.slice(pipeline.indexOf('className="board"'), errorPreview);
  assert.doesNotMatch(board, /width:\s*\d/, 'an inline width would override the responsive rule');
});
