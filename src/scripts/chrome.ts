/**
 * Chrome behaviour — runs once per page load.
 *
 * Handles five things, all set up declaratively from the DOM so we never
 * need to import this from a component:
 *
 *  1. Dark-mode toggle (persisted to localStorage `sd-theme`).
 *  2. Reading-progress bar (only updates when the `.progress-bar` is on
 *     the page — i.e. inside a BaseLayout with `progress`).
 *  3. TOC active-link highlighting on scroll (uses any `[data-toc]` nav).
 *  4. Smooth-scroll for in-page anchor links.
 *  5. Product-analytics dispatch (page view + funnel clicks) from `data-*`
 *     hooks, via the analytics wrapper (see docs/analytics-events.md).
 *
 * The analytics SDKs themselves are bootstrapped separately by the
 * ConsentBanner island, which gates Mixpanel/GA4 behind the visitor's consent
 * choice; track() here simply buffers until that choice is made.
 */

import { track, EVENTS, type EventProps } from '@lib/analytics';

declare global {
  interface Window {
    __sdChromeInit?: true;
  }
}

if (!window.__sdChromeInit) {
  window.__sdChromeInit = true;
  const root = document.documentElement;

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

  function toggleTheme(): void {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (next === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem('sd-theme', next);
    } catch {}
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
