/**
 * Chrome behaviour — runs once per page load.
 *
 * Handles four things, all set up declaratively from the DOM so we never
 * need to import this from a component:
 *
 *  1. Dark-mode toggle (persisted to localStorage `sd-theme`).
 *  2. Reading-progress bar (only updates when the `.progress-bar` is on
 *     the page — i.e. inside a BaseLayout with `progress`).
 *  3. TOC active-link highlighting on scroll (uses any `[data-toc]` nav).
 *  4. Smooth-scroll for in-page anchor links.
 */

declare global {
  interface Window {
    __sdChromeInit?: true;
  }
}

if (!window.__sdChromeInit) {
  window.__sdChromeInit = true;
  const root = document.documentElement;

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
