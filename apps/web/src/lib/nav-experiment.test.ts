import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyNavExperimentItems,
  captureNavExperimentItems,
  NAV_HIDDEN_QUERY,
  NAV_ITEM_ATTRIBUTE,
} from './nav-experiment.ts';

/**
 * Minimal stand-ins for the four DOM members this module uses -
 * `getAttribute`, `parentElement`, `nextElementSibling`, `remove()` and the
 * nav's `insertBefore`. There is no DOM in the `node --test` runner and the
 * site has no test-DOM dependency, so the nav is modelled directly.
 */
class FakeAnchor {
  parent: FakeNav | null = null;
  label: string;
  attributes: Record<string, string>;

  constructor(label: string, attributes: Record<string, string> = {}) {
    this.label = label;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  get parentElement(): FakeNav | null {
    return this.parent;
  }

  get nextElementSibling(): FakeAnchor | null {
    const siblings = this.parent?.children ?? [];
    const index = siblings.indexOf(this);
    return index === -1 ? null : (siblings[index + 1] ?? null);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

class FakeNav {
  children: FakeAnchor[] = [];
  parentElement = null;

  insertBefore(node: FakeAnchor, reference: FakeAnchor | null): void {
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index === -1 ? this.children.length : index, 0, node);
    node.parent = this;
  }

  labels(): string[] {
    return this.children.map((child) => child.label);
  }
}

/** The site's six-item primary nav, with About tagged for the experiment. */
function buildNav(): FakeNav {
  const nav = new FakeNav();
  const items = [
    new FakeAnchor('Home'),
    new FakeAnchor('Blog'),
    new FakeAnchor('Categories'),
    new FakeAnchor('Deals'),
    new FakeAnchor('About', { [NAV_ITEM_ATTRIBUTE]: 'remove-about-page' }),
    new FakeAnchor('Contact'),
  ];
  items.forEach((item) => nav.insertBefore(item, null));
  return nav;
}

const FULL_NAV = ['Home', 'Blog', 'Categories', 'Deals', 'About', 'Contact'];
const NAV_WITHOUT_ABOUT = ['Home', 'Blog', 'Categories', 'Deals', 'Contact'];

function capture(nav: FakeNav) {
  return captureNavExperimentItems(nav.children as unknown as Element[]);
}

/** Applies `value` for every feature, and counts how often the flag was read. */
function flag(value: boolean) {
  const reads: string[] = [];
  return {
    reads,
    read: (feature: string): boolean => {
      reads.push(feature);
      return value;
    },
  };
}

test('only tagged items with a parent nav are captured, keyed by their feature', () => {
  const captured = capture(buildNav());
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.feature, 'remove-about-page');
});

test('control (flag false) leaves the six-item nav exactly as it rendered', () => {
  const nav = buildNav();
  const items = capture(nav);
  applyNavExperimentItems(items, false, () => false);
  assert.deepEqual(nav.labels(), FULL_NAV);
});

test('variant B (flag true) removes About from the DOM', () => {
  const nav = buildNav();
  applyNavExperimentItems(capture(nav), false, () => true);
  assert.deepEqual(nav.labels(), NAV_WITHOUT_ABOUT);
});

test('a value flipping back to false restores About in its original slot', () => {
  // The payload is re-read on every stream push and on the 60s poll, so an
  // experiment stopped mid-session has to leave the nav as it was.
  const nav = buildNav();
  const items = capture(nav);
  applyNavExperimentItems(items, false, () => true);
  applyNavExperimentItems(items, false, () => false);
  assert.deepEqual(nav.labels(), FULL_NAV);
});

test('repeated callbacks never double-remove or duplicate the item', () => {
  const nav = buildNav();
  const items = capture(nav);
  applyNavExperimentItems(items, false, () => true);
  applyNavExperimentItems(items, false, () => true);
  assert.deepEqual(nav.labels(), NAV_WITHOUT_ABOUT);

  applyNavExperimentItems(items, false, () => false);
  applyNavExperimentItems(items, false, () => false);
  assert.deepEqual(nav.labels(), FULL_NAV);
});

test('two items under experiment each restore into their own original slot', () => {
  // Restoring before a captured neighbour is only right while that neighbour is
  // still there, so a second experiment removing it must not push About to the
  // end of the nav.
  const nav = new FakeNav();
  [
    new FakeAnchor('Home'),
    new FakeAnchor('Deals', { [NAV_ITEM_ATTRIBUTE]: 'remove-deals' }),
    new FakeAnchor('About', { [NAV_ITEM_ATTRIBUTE]: 'remove-about-page' }),
    new FakeAnchor('Contact'),
  ].forEach((item) => nav.insertBefore(item, null));
  const items = capture(nav);

  applyNavExperimentItems(items, false, () => true);
  assert.deepEqual(nav.labels(), ['Home', 'Contact']);

  applyNavExperimentItems(items, false, () => false);
  assert.deepEqual(nav.labels(), ['Home', 'Deals', 'About', 'Contact']);
});

test('the flag is never read while the nav is hidden, so no one is bucketed', () => {
  // Reading a feature is what buckets a visitor and fires $experiment_viewed;
  // below the breakpoint the nav is display:none with no drawer behind it.
  const nav = buildNav();
  const hiddenNav = flag(true);
  applyNavExperimentItems(capture(nav), true, hiddenNav.read);
  assert.deepEqual(hiddenNav.reads, []);
  assert.deepEqual(nav.labels(), FULL_NAV);
});

test('crossing the breakpoint into view applies the variant on that re-check', () => {
  const nav = buildNav();
  const items = capture(nav);
  const shown = flag(true);
  applyNavExperimentItems(items, true, shown.read);
  applyNavExperimentItems(items, false, shown.read);
  assert.deepEqual(shown.reads, ['remove-about-page']);
  assert.deepEqual(nav.labels(), NAV_WITHOUT_ABOUT);
});

test('the hidden-nav query still matches the breakpoint that hides the nav', () => {
  // The rule this module gates on lives in another file's stylesheet, so read
  // it: any drift would leave widths where the nav is hidden but the visitor is
  // bucketed anyway, and nothing else in the build would notice.
  const header = readFileSync(new URL('../components/layout/Header.astro', import.meta.url), 'utf8');
  const hidesNav = /@media\s*([^{]+?)\s*\{\s*\.site-nav\s*\{\s*display:\s*none/.exec(header);
  assert.ok(hidesNav, 'Header.astro no longer hides .site-nav at a breakpoint');
  assert.equal(NAV_HIDDEN_QUERY, hidesNav[1]);
});
