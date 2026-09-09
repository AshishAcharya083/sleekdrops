/**
 * The brand mark is a two-colour glyph sitting on its own tinted tile, and a
 * build never notices when those colours stop contrasting: v0.10.0 shipped the
 * droplet as a literal #FAFAF7, which is the light-mode paper - so in dark mode
 * the droplet was drawn in almost exactly the colour of the tile behind it and
 * the mark rendered as an empty square. This reads the component and the theme
 * tokens as text (the way site-env.test.ts reads the deploy workflows) and
 * checks the glyph still stands out in both themes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const component = read('./BrandMark.astro');
const tokens = read('../../styles/tokens.css');

type Theme = 'light' | 'dark';

/** The custom properties one theme block declares, e.g. `--ink` -> `#0F0F0E`. */
function themeTokens(theme: Theme): Map<string, string> {
  const selector = theme === 'light' ? ':root {' : ':root[data-theme="dark"]';
  const start = tokens.indexOf(selector);
  assert.ok(start >= 0, `tokens.css no longer declares the ${theme} theme with ${selector}`);
  const block = tokens.slice(start, tokens.indexOf('}', start));
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]),
  );
}

/** A colour as written in the markup, resolved against one theme. */
function resolve(color: string, theme: Theme): string {
  const token = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!token) return color.trim();
  const value = themeTokens(theme).get(token[1]);
  assert.ok(value, `${color} is not defined in the ${theme} theme`);
  return value;
}

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected a six-digit hex colour, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** WCAG relative luminance and contrast ratio. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b2] = channels(hex).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function colorOf(pattern: RegExp, what: string): string {
  const match = pattern.exec(component);
  assert.ok(match, `BrandMark.astro no longer declares ${what}`);
  return match[1];
}

const tile = colorOf(/\.brand \.mark \{[^}]*background:\s*([^;]+);/s, 'the tile background');
const droplet = colorOf(/<path[^>]*\sfill="([^"]+)"/, 'the droplet fill');
const highlight = colorOf(/<circle[^>]*\sfill="([^"]+)"/, 'the droplet highlight');

// WCAG 2.1 SC 1.4.11 (non-text contrast) for a graphic that carries meaning.
const MIN_CONTRAST = 3;

for (const theme of ['light', 'dark'] as const) {
  test(`the droplet stands out against its tile in ${theme} mode`, () => {
    const ratio = contrast(resolve(droplet, theme), resolve(tile, theme));
    assert.ok(
      ratio >= MIN_CONTRAST,
      `droplet vs tile is ${ratio.toFixed(2)}:1 in ${theme} mode, below ${MIN_CONTRAST}:1`,
    );
  });

  test(`the highlight stays visible on the droplet in ${theme} mode`, () => {
    const ratio = contrast(resolve(highlight, theme), resolve(droplet, theme));
    assert.ok(
      ratio >= MIN_CONTRAST,
      `highlight vs droplet is ${ratio.toFixed(2)}:1 in ${theme} mode, below ${MIN_CONTRAST}:1`,
    );
  });
}
