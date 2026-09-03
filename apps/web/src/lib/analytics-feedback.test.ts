/**
 * The in-app feedback dialog, asserted where the visitor actually meets it: on
 * the dialog the **real** SDK mounts into its shadow host once
 * `allowUserFeedback` is on.
 *
 * Two things about that dialog come from outside the SDK's release, and each is
 * silent when it breaks. Its wide desktop layout comes from a patch over the
 * SDK's `dist/` (see patches/README.md) - a patch that stops applying leaves the
 * widget working, only back at 560 px with the page screenshot the visitor is
 * meant to annotate shrunk to a thumbnail. Its heading is site copy, passed
 * through the SDK's own `feedback.title` option precisely so that it does *not*
 * ride on that patch, which is deleted the day the SDK releases the layout.
 * The tests below pin all three: the site's heading, the SDK default the site
 * overrides (so a heading baked back into the patch is caught), and the layout.
 *
 * The SDK builds the dialog with plain DOM calls, so `mountDom` below is a
 * document just complete enough to hold it - nothing about the widget or about
 * `analytics.ts` is stubbed.
 *
 * Run it with `pnpm --filter @sleekdrops/web test`: substituting the env seam
 * needs node's `--experimental-test-module-mocks`, which that script passes.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAnalytics } from '@getdevteam/analytics-web';

/** Feedback on, as a build that sets PUBLIC_DEVTEAM_ANALYTICS_FEEDBACK=true has it. */
mock.module(new URL('./analytics-env.ts', import.meta.url).href, {
  namedExports: {
    analyticsEnv: () => ({ key: 'dtp_test', host: 'http://analytics.test', feedback: true }),
  },
});

type AnalyticsModule = typeof import('./analytics.ts');

const { grantConsent } = (await import(
  new URL('./analytics.ts', import.meta.url).href
)) as AnalyticsModule;

/** One node of the document the SDK builds its dialog in. */
interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  type: string;
  src: string;
  async: boolean;
  width: number;
  height: number;
  value: string;
  placeholder: string;
  maxLength: number;
  style: Record<string, string>;
  childNodes: FakeElement[];
  shadowRoot: FakeElement | undefined;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): void;
    contains(name: string): boolean;
  };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  attachShadow(init: { mode: string }): FakeElement;
  append(...nodes: FakeElement[]): void;
  appendChild(node: FakeElement): FakeElement;
  insertBefore(node: FakeElement, before: FakeElement | null): FakeElement;
  remove(): void;
  addEventListener(): void;
  removeEventListener(): void;
  getContext(): null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

function createElement(tagName: string): FakeElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const node: FakeElement = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    type: '',
    src: '',
    async: false,
    width: 0,
    height: 0,
    value: '',
    placeholder: '',
    maxLength: 0,
    style: {},
    childNodes: [],
    shadowRoot: undefined,
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      toggle: (name, force) =>
        void ((force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => void attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    attachShadow: () => (node.shadowRoot = createElement('#shadow-root')),
    append: (...nodes) => void node.childNodes.push(...nodes),
    appendChild: (child) => (node.childNodes.push(child), child),
    insertBefore: (child, before) => {
      const at = before === null ? -1 : node.childNodes.indexOf(before);
      node.childNodes.splice(at === -1 ? node.childNodes.length : at, 0, child);
      return child;
    },
    remove: () => {
      /* detachment is not observed by anything asserted here */
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return node;
}

/**
 * The first element in `root`'s tree - shadow trees included - carrying `className`,
 * matched as one of the element's classes the way a `.class` selector would.
 */
function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  for (const child of [...(root.shadowRoot ? [root.shadowRoot] : []), ...root.childNodes]) {
    if (child.className.split(' ').includes(className)) return child;
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

/** One storage area, scoped to whatever installs it. */
function createStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => void entries.set(key, value),
    removeItem: (key: string): void => void entries.delete(key),
  };
}

/**
 * Install a document the SDK can mount into, and answer with its `<body>` - the
 * dialog's shadow host is appended there, so it is where the assertions start.
 */
function mountDom(): FakeElement {
  const body = createElement('body');
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const window = {
    localStorage,
    sessionStorage,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  const document = {
    body,
    head: createElement('head'),
    documentElement: createElement('html'),
    createElement,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    referrer: '',
    visibilityState: 'visible',
    cookie: '',
  };
  Object.assign(globalThis, {
    window,
    document,
    localStorage,
    sessionStorage,
    location: {
      pathname: '/',
      href: 'https://sleekdrops.com/',
      origin: 'https://sleekdrops.com',
      hostname: 'sleekdrops.com',
      protocol: 'https:',
    },
    fetch: () => Promise.resolve({ ok: true, status: 200 }),
  });
  return body;
}

/**
 * The dialog mounted under `body`, once the SDK's lazily imported feedback chunk
 * has landed. Resolves to undefined if it never mounts, so a widget that silently
 * stopped appearing fails rather than passes.
 */
async function mountedDialog(body: FakeElement): Promise<FakeElement | undefined> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const panel = findByClass(body, 'panel');
    if (panel) return panel;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return undefined;
}

async function feedbackTitle(body: FakeElement): Promise<string | undefined> {
  await mountedDialog(body);
  return findByClass(body, 'title')?.textContent;
}

/** The stylesheet the dialog is drawn with, as the SDK wrote it into the shadow root. */
async function feedbackStyles(body: FakeElement): Promise<string> {
  await mountedDialog(body);
  const host = body.childNodes.find((node) => node.getAttribute('data-devteam-feedback') !== null);
  const style = host?.shadowRoot?.childNodes.find((node) => node.tagName === 'style');
  return style?.textContent ?? '';
}

test('the site names the feedback dialog, so the wording does not ride on the layout patch', async () => {
  const body = mountDom();

  grantConsent();

  assert.equal(await feedbackTitle(body), 'Send feedback by drawing or describing');
});

test('the SDK default the site overrides is the SDK default, not the site copy', async () => {
  const body = mountDom();

  createAnalytics({
    key: 'dtp_test',
    host: 'http://analytics.test',
    trackPageviews: false,
    autoCaptureErrors: false,
    allowUserFeedback: true,
  });

  assert.equal(
    await feedbackTitle(body),
    'Send feedback',
    'the layout patch must stay layout-only - a heading baked back into it would make the site option dead code',
  );
});

/**
 * The patch is the whole point of pinning this SDK version, and an unapplied one
 * is silent: the widget still mounts, only back at 560 px with the page
 * screenshot shrunk to a thumbnail. This is what says so out loud.
 */
test('the feedback dialog is laid out wide, so the layout patch is applied', async () => {
  const body = mountDom();

  grantConsent();
  const styles = await feedbackStyles(body);

  assert.match(styles, /\.panel\b[^}]*width: min\(1600px/, 'expected the wide desktop dialog');
  assert.match(styles, /\.panel\.compact\b[^}]*width: min\(560px/, 'expected the compact fallback');
  assert.match(styles, /@media \(max-width: 860px\)/, 'expected the single-column mobile layout');
});
