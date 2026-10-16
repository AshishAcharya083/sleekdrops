/**
 * The trust-surface dispatch, driven the way chrome.ts drives it: a document
 * carrying the exact hooks the rendering components emit, and the `track` /
 * `warn` callbacks chrome.ts passes in. The fixture elements take their
 * attributes as written in the markup (`data-score-explainer-props`) and expose
 * them through `dataset` with the browser's camel-casing, so a typo on either
 * side of that mapping fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BADGE_REGISTRY, CURRENT_METHOD_VERSION } from './trust.ts';
import { wireTrustAnalytics, type TrustEvent } from './trust-analytics.ts';
import type { EventProps } from './pii.ts';

interface FixtureElement {
  tag: string;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  open: boolean;
  dispatch(type: string): void;
}

function element(tag: string, attributes: Record<string, string> = {}): FixtureElement {
  const listeners = new Map<string, (() => void)[]>();
  const dataset: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!name.startsWith('data-')) continue;
    dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  const el = {
    tag,
    attributes,
    dataset,
    open: 'open' in attributes,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  return el;
}

/** A document holding `elements`, answering the `tag[attr]` / `[attr]` selectors the dispatch uses. */
function fixtureDocument(elements: FixtureElement[]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      const match = /^([a-z]*)\[([a-z-]+)\]$/.exec(selector);
      assert.ok(match, `fixture cannot answer selector ${selector}`);
      const [, tag, attribute] = match;
      return elements.filter((el) => (!tag || el.tag === tag) && attribute in el.attributes);
    },
  } as unknown as ParentNode;
}

/** chrome.ts's parseProps, verbatim in behaviour. */
function parseProps(raw: string | undefined): EventProps | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as EventProps;
  } catch {
    return undefined;
  }
}

function wire(elements: FixtureElement[], screenName?: string) {
  const tracked: { event: TrustEvent; props: EventProps | undefined }[] = [];
  const warnings: string[] = [];
  wireTrustAnalytics(fixtureDocument(elements), {
    screenName,
    parseProps,
    track: (event, props) => tracked.push({ event, props }),
    warn: (message) => warnings.push(message),
  });
  return { tracked, warnings };
}

// ── Methodology Viewed ──────────────────────────────────────────────────────

test('the methodology page reports one view carrying the current method version', () => {
  const { tracked, warnings } = wire([], 'how-we-rate');
  assert.deepEqual(tracked, [
    { event: 'methodologyViewed', props: { method_version: CURRENT_METHOD_VERSION } },
  ]);
  assert.deepEqual(warnings, []);
});

test('no other screen reports a methodology view', () => {
  for (const screen of [undefined, 'blog-post', 'how-we-research', 'home']) {
    const { tracked } = wire([], screen);
    assert.deepEqual(tracked, [], `screen ${screen}`);
  }
});

test('the methodology page still wires the other hooks it renders', () => {
  const link = badgeLink('review-score');
  const { tracked } = wire([link], 'how-we-rate');
  link.dispatch('click');
  assert.deepEqual(tracked.map((entry) => entry.event), ['methodologyViewed', 'trustBadgeClicked']);
});

// ── Score Explainer Expanded ────────────────────────────────────────────────

function explainer(props = '{"slug":"harman-kardon-luna-2","band":"strong"}'): FixtureElement {
  return element('details', {
    'data-score-explainer': '',
    'data-score-explainer-props': props,
  });
}

test('opening a closed score explainer reports it once, with its slug and band', () => {
  const details = explainer();
  const { tracked } = wire([details]);
  assert.deepEqual(tracked, []);

  details.open = true;
  details.dispatch('toggle');

  assert.deepEqual(tracked, [
    {
      event: 'scoreExplainerExpanded',
      props: { slug: 'harman-kardon-luna-2', band: 'strong' },
    },
  ]);
});

test('closing and re-opening the same explainer is still one expansion', () => {
  const details = explainer();
  const { tracked } = wire([details]);

  details.open = true;
  details.dispatch('toggle');
  details.open = false;
  details.dispatch('toggle');
  details.open = true;
  details.dispatch('toggle');

  assert.equal(tracked.length, 1);
});

test('each explainer on a page is counted on its own', () => {
  const first = explainer('{"slug":"a","band":"excellent"}');
  const second = explainer('{"slug":"b","band":"mixed"}');
  const { tracked } = wire([first, second]);

  second.open = true;
  second.dispatch('toggle');
  first.open = true;
  first.dispatch('toggle');

  assert.deepEqual(
    tracked.map((entry) => entry.props?.slug),
    ['b', 'a'],
  );
});

test('a toggle that closes the explainer reports nothing', () => {
  const details = explainer();
  const { tracked } = wire([details]);
  details.open = false;
  details.dispatch('toggle');
  assert.deepEqual(tracked, []);
});

test('an explainer with malformed props still reports the expansion, with no props', () => {
  const details = explainer('{"slug":"harman');
  const { tracked, warnings } = wire([details]);
  details.open = true;
  details.dispatch('toggle');
  assert.deepEqual(tracked, [{ event: 'scoreExplainerExpanded', props: undefined }]);
  assert.deepEqual(warnings, []);
});

test('a data-score-explainer that is not a <details> is not wired', () => {
  const div = element('div', { 'data-score-explainer': '' });
  const { tracked } = wire([div]);
  div.open = true;
  div.dispatch('toggle');
  assert.deepEqual(tracked, []);
});

// ── Trust Badge Clicked ─────────────────────────────────────────────────────

function badgeLink(kind: string, props = '{"slug":"ninja-blast","placement":"deal-detail"}') {
  return element('a', { 'data-trust-badge': kind, 'data-trust-badge-props': props });
}

test('a badge proof-link click reports its kind and the props it carries', () => {
  const link = badgeLink('review-score');
  const { tracked, warnings } = wire([link]);

  link.dispatch('click');

  assert.deepEqual(tracked, [
    {
      event: 'trustBadgeClicked',
      props: { slug: 'ninja-blast', placement: 'deal-detail', badge_kind: 'review-score' },
    },
  ]);
  assert.deepEqual(warnings, []);
});

test('every click is its own event', () => {
  const link = badgeLink('review-score');
  const { tracked } = wire([link]);
  link.dispatch('click');
  link.dispatch('click');
  assert.equal(tracked.length, 2);
});

test("the attribute's kind wins over a badge_kind smuggled into the props", () => {
  const link = badgeLink('honest-negative', '{"slug":"x","placement":"home","badge_kind":"lowest-price"}');
  const { tracked } = wire([link]);
  link.dispatch('click');
  assert.equal(tracked[0]?.props?.badge_kind, 'honest-negative');
});

test('a badge with malformed props still reports its kind', () => {
  const link = badgeLink('review-score', 'not json');
  const { tracked } = wire([link]);
  link.dispatch('click');
  assert.deepEqual(tracked, [{ event: 'trustBadgeClicked', props: { badge_kind: 'review-score' } }]);
});

test('a kind outside the badge registry is dropped with one warning per click', () => {
  for (const kind of ['editors-choice', '', 'toString', '__proto__']) {
    const link = badgeLink(kind);
    const { tracked, warnings } = wire([link]);
    link.dispatch('click');
    assert.deepEqual(tracked, [], `kind ${JSON.stringify(kind)}`);
    assert.equal(warnings.length, 1, `kind ${JSON.stringify(kind)}`);
    assert.match(warnings[0], /data-trust-badge/);
  }
});

test('every registry kind is accepted, enabled or not', () => {
  // A disabled kind never renders, but if one ever did its click is still a
  // real badge - the registry, not the enabled flag, is the vocabulary.
  for (const kind of Object.keys(BADGE_REGISTRY)) {
    const link = badgeLink(kind);
    const { tracked, warnings } = wire([link]);
    link.dispatch('click');
    assert.equal(tracked[0]?.props?.badge_kind, kind);
    assert.deepEqual(warnings, [], kind);
  }
});

// ── A page without the surfaces ─────────────────────────────────────────────

test('a page with none of the hooks fires nothing and logs nothing', () => {
  const plain = [element('a', { href: '/deals/x', 'data-track': 'Deal Card Clicked' }), element('details')];
  const { tracked, warnings } = wire(plain, 'deal-detail');
  for (const el of plain) {
    el.open = true;
    el.dispatch('toggle');
    el.dispatch('click');
  }
  assert.deepEqual(tracked, []);
  assert.deepEqual(warnings, []);
});
