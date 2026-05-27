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
}

export {};
