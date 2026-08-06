/**
 * Chrome behaviour — runs once per page load.
 *
 * Handles six things, all set up declaratively from the DOM so we never
 * need to import this from a component:
 *
 *  1. Dark-mode toggle (persisted to localStorage `sd-theme`).
 *  2. Reading-progress bar (only updates when the `.progress-bar` is on
 *     the page — i.e. inside a BaseLayout with `progress`).
 *  3. TOC active-link highlighting on scroll (uses any `[data-toc]` nav).
 *  4. Smooth-scroll for in-page anchor links.
 *  5. Product-analytics dispatch (page view + funnel clicks) from `data-*`
 *     hooks, via the analytics wrapper (see docs/analytics-events.md).
 *  6. A/B experiment copy: swapping `[data-experiment-copy]` labels in place
 *     once the flag payload resolves, via the experiments wrapper.
 *  7. A/B experiment nav items: removing (and restoring) a
 *     `[data-experiment-nav-item]` entry in the primary nav from the same
 *     payload, while the nav is on screen.
 *
 * The analytics SDKs themselves are bootstrapped separately by the
 * ConsentBanner island, which gates the DevTeam + GA4 analytics sinks behind the visitor's consent
 * choice; track() here simply buffers until that choice is made.
 */

import { track, EVENTS, initErrorCapture, type EventProps } from '@lib/analytics';
import { getFeatureValue, subscribe as onExperimentsChanged } from '@lib/experiments';
import {
  applyNavExperimentItems,
  captureNavExperimentItems,
  NAV_HIDDEN_QUERY,
  NAV_ITEM_ATTRIBUTE,
} from '@lib/nav-experiment';

declare global {
  interface Window {
    __sdChromeInit?: true;
  }
}

if (!window.__sdChromeInit) {
  window.__sdChromeInit = true;
  const root = document.documentElement;

  /* Forward uncaught errors and unhandled rejections to analytics. Routes
     through the same consent-gated track() pipeline as everything else, and is
     wrapped so a reporting failure can never break page rendering. */
  try {
    initErrorCapture();
  } catch {
    /* error capture is best-effort - never let it break the page */
  }

  /* ---- Product analytics ----------------------------------------------
   * All tracking is wired declaratively from the DOM (matching the rest of
   * this file): pages tag the <body> with the page-view payload, and funnel
   * elements carry `data-track` + an optional JSON `data-track-props`. See
   * docs/analytics-events.md for the taxonomy. Analytics is initialised behind
   * the consent gate by the ConsentBanner island; track() buffers until the
   * visitor chooses and drops everything on a decline, so none of this needs
   * guarding. */
  const parseProps = (raw: string | undefined): EventProps | undefined => {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EventProps;
    } catch {
      return undefined;
    }
  };

  /* Page view: every page reports a 'Page Viewed', enriched with the screen
     context BaseLayout declares on <body data-page-view>. path/referrer are
     always included so a page that declares no screen is still counted. */
  const pageView = parseProps(document.body.dataset.pageView);
  const screenName = typeof pageView?.screen === 'string' ? pageView.screen : undefined;
  track(EVENTS.pageView, {
    path: location.pathname,
    referrer: document.referrer,
    ...pageView,
  });

  /* Funnel-step clicks: hero CTAs, deal cards, affiliate "View deal" buttons.
     The event fires synchronously here, before the browser follows the link. */
  document.querySelectorAll<HTMLElement>('[data-track]').forEach((el) => {
    el.addEventListener('click', () => {
      const event = el.dataset.track;
      if (event) track(event, parseProps(el.dataset.trackProps));
    });
  });

  /* ---- Experiment copy -------------------------------------------------
   * An element tagged `data-experiment-copy="<feature key>"` renders its
   * default copy in the static HTML and has it swapped in place once the flag
   * payload resolves - never blanked, hidden or delayed, so there is no layout
   * shift beyond the new label's own width. The rendered text *is* the code-side
   * default, which keeps the default and the markup from drifting apart.
   *
   * The enclosing `data-track` element's `cta` prop is rewritten alongside it,
   * so the funnel event always reports the label the visitor actually saw.
   * Feature reads outside consent return the default, so this needs no guard. */
  const copySlots = [
    ...document.querySelectorAll<HTMLElement>('[data-experiment-copy]'),
  ].map((el) => ({
    el,
    feature: el.dataset.experimentCopy ?? '',
    fallback: (el.textContent ?? '').trim(),
  }));

  if (copySlots.length > 0) {
    onExperimentsChanged(() => {
      copySlots.forEach(({ el, feature, fallback }) => {
        const copy = getFeatureValue(feature, fallback);
        if (el.textContent === copy) return;
        el.textContent = copy;
        const host = el.closest<HTMLElement>('[data-track]');
        const props = parseProps(host?.dataset.trackProps);
        if (host && props && typeof props.cta === 'string') {
          host.dataset.trackProps = JSON.stringify({ ...props, cta: copy });
        }
      });
    });
  }

  /* ---- Experiment nav items --------------------------------------------
   * A nav entry tagged `data-experiment-nav-item="<feature key>"` ships in the
   * static HTML for every visitor, so control and variant are served the same
   * markup and the split happens at runtime. Once the payload resolves, a true
   * value takes the entry out of the DOM - not out of view, so it leaves the
   * accessibility tree and the tab order too - and a value flipping back puts
   * it in the slot it rendered in.
   *
   * The flag is read only while the primary nav is displayed: below its
   * breakpoint the nav is `display: none` with no drawer behind it, and reading
   * a feature is what buckets the visitor, so a read there would count an
   * exposure for a treatment that visitor can never see. */
  const navExperimentItems = captureNavExperimentItems(
    document.querySelectorAll<HTMLElement>(`[${NAV_ITEM_ATTRIBUTE}]`),
  );

  if (navExperimentItems.length > 0) {
    const navHidden = window.matchMedia(NAV_HIDDEN_QUERY);
    const applyNavExperiments = (): void =>
      applyNavExperimentItems(navExperimentItems, navHidden.matches, (feature) =>
        getFeatureValue(feature, false),
      );
    onExperimentsChanged(applyNavExperiments);
    navHidden.addEventListener('change', applyNavExperiments);
  }

  function toggleTheme(): void {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (next === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem('sd-theme', next);
    } catch {}
    track(EVENTS.themeToggled, { theme: next });
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', toggleTheme);
  });

  const bar = document.querySelector<HTMLElement>('.progress-bar');
  if (bar) {
    const update = (): void => {
      const h = document.documentElement;
      const scrolled = h.scrollTop;
      const max = h.scrollHeight - h.clientHeight;
      const pct = max > 0 ? Math.min(100, (scrolled / max) * 100) : 0;
      bar.style.width = `${pct}%`;
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  const tocLinks = document.querySelectorAll<HTMLAnchorElement>('[data-toc] a');
  if (tocLinks.length > 0) {
    const targets = [...tocLinks]
      .map((a) => {
        const id = a.getAttribute('href')?.replace('#', '') ?? '';
        const el = document.getElementById(id);
        return el ? { a, el } : null;
      })
      .filter(<T,>(x: T | null): x is T => x !== null);

    tocLinks.forEach((a) => {
      a.addEventListener('click', () => {
        track(EVENTS.tocLinkClicked, { section: a.textContent?.trim() || a.getAttribute('href') || '' });
      });
    });

    const onScroll = (): void => {
      const y = window.scrollY + 120;
      let active = targets[0];
      for (const t of targets) {
        if (t.el.offsetTop <= y) active = t;
      }
      targets.forEach((t) => {
        t.a.parentElement?.classList.toggle('active', t === active);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  document
    .querySelectorAll<HTMLFormElement>('[data-mock-form]')
    .forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (form.dataset.signup !== undefined) {
          track(EVENTS.newsletterSignup, screenName ? { screen: screenName } : undefined);
        }
        const label = form.dataset.mockLabel ?? '✓ Done';
        const button = form.querySelector('button');
        if (button) button.textContent = label;
      });
    });

  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href')?.slice(1) ?? '';
      const el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        window.scrollTo({ top: el.offsetTop - 90, behavior: 'smooth' });
      }
    });
  });

  /* ---- Share button (Web Share API w/ clipboard fallback) ---- */
  const flashLabel = (el: HTMLElement, label: string, ms = 1500): void => {
    const prev = el.getAttribute('title') ?? '';
    el.setAttribute('title', label);
    el.classList.add('is-flashed');
    window.setTimeout(() => {
      el.setAttribute('title', prev);
      el.classList.remove('is-flashed');
    }, ms);
  };

  document.querySelectorAll<HTMLElement>('[data-share]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      track(EVENTS.shareClicked, screenName ? { screen: screenName } : undefined);
      const url = window.location.href;
      const title = btn.dataset.shareTitle ?? document.title;
      const text = btn.dataset.shareText ?? '';
      const nav = navigator as Navigator & {
        share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      };
      if (nav.share) {
        try {
          await nav.share({ title, text, url });
          return;
        } catch {
          /* user cancelled — fall through to copy */
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        flashLabel(btn, 'Link copied');
      } catch {
        window.prompt('Copy this link:', url);
      }
    });
  });

  /* ---- Copy-link button ---- */
  document.querySelectorAll<HTMLElement>('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      track(EVENTS.copyLinkClicked, screenName ? { screen: screenName } : undefined);
      const url = window.location.href;
      try {
        await navigator.clipboard.writeText(url);
        flashLabel(btn, 'Link copied');
      } catch {
        window.prompt('Copy this link:', url);
      }
    });
  });

  /* ---- Affiliate links in markdown content: open in new tab ---- */
  document
    .querySelectorAll<HTMLAnchorElement>('.article-body a[href^="http"]')
    .forEach((a) => {
      const sameOrigin = a.host === window.location.host;
      if (sameOrigin) return;
      if (!a.target) a.target = '_blank';
      const rels = new Set((a.rel || '').split(/\s+/).filter(Boolean));
      rels.add('noopener');
      rels.add('noreferrer');
      a.rel = Array.from(rels).join(' ');
    });

  /* ---- Hero image lightbox ---- */
  const lightboxTrigger = document.querySelector<HTMLElement>('[data-lightbox]');
  if (lightboxTrigger) {
    const img = lightboxTrigger.querySelector<HTMLImageElement>('img');
    if (img) {
      lightboxTrigger.setAttribute('tabindex', '0');
      lightboxTrigger.setAttribute('role', 'button');
      lightboxTrigger.setAttribute('aria-label', 'Open full-size image');

      const open = (): void => {
        track(EVENTS.lightboxOpened, screenName ? { screen: screenName } : undefined);
        const overlay = document.createElement('div');
        overlay.className = 'sd-lightbox';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', img.alt || 'Image preview');
        const big = document.createElement('img');
        big.src = img.currentSrc || img.src;
        big.alt = img.alt;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'sd-lightbox-close';
        close.setAttribute('aria-label', 'Close image');
        close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        overlay.appendChild(big);
        overlay.appendChild(close);
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        const closeFn = (): void => {
          overlay.remove();
          document.body.style.overflow = '';
          document.removeEventListener('keydown', onKey);
        };
        const onKey = (ev: KeyboardEvent): void => {
          if (ev.key === 'Escape') closeFn();
        };
        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay || ev.target === close || (ev.target as HTMLElement).closest('.sd-lightbox-close')) closeFn();
        });
        document.addEventListener('keydown', onKey);
        requestAnimationFrame(() => overlay.classList.add('is-open'));
      };

      lightboxTrigger.addEventListener('click', open);
      lightboxTrigger.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter' || (ev as KeyboardEvent).key === ' ') {
          ev.preventDefault();
          open();
        }
      });
    }
  }
}

export {};
