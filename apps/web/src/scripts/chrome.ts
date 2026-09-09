/**
 * Chrome behaviour — runs once per page load.
 *
 * Handles seven things, all set up declaratively from the DOM so we never
 * need to import this from a component:
 *
 *  1. Dark-mode toggle (persisted to localStorage `sd-theme`).
 *  2. Reading-progress bar (only updates when the `.progress-bar` is on
 *     the page — i.e. inside a BaseLayout with `progress`).
 *  3. TOC active-link highlighting on scroll (uses any `[data-toc]` nav).
 *  4. Smooth-scroll for in-page anchor links, plus a highlight flash so the
 *     click is acknowledged even when the target is already on screen.
 *  5. Product-analytics dispatch (page view, list views, funnel clicks,
 *     outbound-click decoration and read completion) from `data-*` hooks, via
 *     the analytics wrapper (see docs/analytics-events.md).
 *  6. A/B experiment copy: swapping `[data-experiment-copy]` labels in place
 *     once the flag payload resolves, via the experiments wrapper.
 *  7. A/B experiment nav items: removing (and restoring) a
 *     `[data-experiment-nav-item]` entry in the primary nav from the same
 *     payload, while the nav is on screen.
 *
 * The analytics SDKs themselves are bootstrapped separately by the
 * PrivacyPreferences island, which applies the visitor's stored decision (or the
 * site default: anonymous analytics on, advertising off) to the DevTeam + GA4
 * sinks; track() here simply buffers until that has happened.
 */

import {
  captureError,
  track,
  trackPageView,
  EVENTS,
  getTraceId,
  initErrorCapture,
  isEventName,
  serverLog,
  type EventProps,
} from '@lib/analytics';
import { resolveAnchorScrollTop } from '@lib/anchor-scroll';
import { decorateGoHref, isGoLink } from '@lib/outbound';
import {
  ActiveTime,
  ReadCompletionGate,
  activeTimeBucket,
  READ_ACTIVE_MS,
} from '@lib/read-completion';
import { newEventId } from '@lib/visit';
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
   * the consent gate by the PrivacyPreferences island; track() buffers until
   * the decision in force is applied and drops everything on a decline, so
   * none of this needs guarding. */
  const parseProps = (raw: string | undefined): EventProps | undefined => {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EventProps;
    } catch {
      return undefined;
    }
  };

  /* Page view: every page reports a 'Page Viewed', enriched with the screen
     context BaseLayout declares on <body data-page-view>. referrer is always
     included so a page that declares no screen is still counted; the normalized
     path is stamped by trackPageView itself, which also holds the
     one-per-document guard - so a second entry point reaching this dispatch, or a
     re-run of it, cannot report the same page view twice. */
  const pageView = parseProps(document.body.dataset.pageView);
  const screenName = typeof pageView?.screen === 'string' ? pageView.screen : undefined;
  trackPageView({ referrer: document.referrer, ...pageView });

  /* List views: one event per rendered deal or promo list, never one per card.
     The list element carries the whole payload as JSON on `data-list-view`
     (list id, cards rendered, page and batch) and the event name stays in code,
     where the compiler checks it. Impressions are the highest-volume signal on
     a deals site, so the per-list shape is what keeps the volume proportionate
     to the pages rendered rather than to the cards on them. */
  document.querySelectorAll<HTMLElement>('[data-list-view]').forEach((list) => {
    const props = parseProps(list.dataset.listView);
    if (props) track(EVENTS.listingViewed, props);
  });

  /* Outbound affiliate clicks: mint the per-click join key, put it on the event
     and on the /go URL the browser is about to follow, and send this session's
     trace id with it.

     Rewriting the href inside the click handler is safe and is the point: the
     listener runs before the browser reads the href to navigate, so the server
     sees exactly the id this event reported. The Function counts the click again
     when it serves the redirect - that count is the ad-block-proof one - and
     threads the same id into the affiliate network's sub-id slot, which is what
     joins a sale reported days later back to this deal, page and position. */
  const decorateOutbound = (el: HTMLElement, props: EventProps | undefined): EventProps => {
    const anchor = el.closest<HTMLAnchorElement>('a[href]');
    const href = anchor?.getAttribute('href');
    if (!anchor || !isGoLink(href)) return { ...props };
    const clickId = newEventId();
    anchor.setAttribute(
      'href',
      decorateGoHref(href, {
        clickId,
        traceId: getTraceId(),
        placement: typeof props?.placement === 'string' ? props.placement : undefined,
        position: typeof props?.position === 'number' ? props.position : undefined,
      }),
    );
    return { ...props, click_id: clickId };
  };

  /* Funnel-step clicks: hero CTAs, deal cards, affiliate "View deal" buttons.
     The event fires synchronously here, before the browser follows the link.

     This is the only path by which an event name reaches track() as a runtime
     string rather than as an EVENTS constant the compiler checked, so the name
     is validated against the taxonomy here: an unknown one is dropped and
     reported rather than sent, which keeps docs/analytics-events.md canonical
     for everything the platform actually receives. */
  document.querySelectorAll<HTMLElement>('[data-track]').forEach((el) => {
    el.addEventListener('click', () => {
      const event = el.dataset.track;
      if (!event) return;
      if (!isEventName(event)) {
        serverLog('warn', `data-track name is not in the event taxonomy, dropped: ${event}`);
        return;
      }
      const props = parseProps(el.dataset.trackProps);
      track(event, event === EVENTS.affiliateClick ? decorateOutbound(el, props) : props);
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
    } catch (error) {
      /* The mode applies to this page either way, but it will not survive the
         next navigation - "dark mode keeps resetting" is a real complaint with
         no other trace, so the write failure is reported rather than dropped. */
      captureError(error, { feature: 'theme-storage', theme: next });
    }
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

  /* ---- Self-clearing class flash ----------------------------------------
   * The acknowledgement mechanism for controls that act without navigating.
   * Re-firing restarts the window rather than letting the first timer strip the
   * class out from under the second flash - which is exactly what a visitor
   * clicking the same control three times in a row produces. */
  const pendingFlashes = new WeakMap<Element, number>();
  const flashClass = (el: Element, className: string, ms: number, onEnd?: () => void): void => {
    const pending = pendingFlashes.get(el);
    if (pending !== undefined) window.clearTimeout(pending);
    el.classList.add(className);
    pendingFlashes.set(
      el,
      window.setTimeout(() => {
        pendingFlashes.delete(el);
        el.classList.remove(className);
        onEnd?.();
      }, ms),
    );
  };

  /* ---- In-page anchor links ---------------------------------------------
   * Three outcomes, and every one of them is visible to the visitor:
   *
   *  - No such target on this page: do nothing at all, explicitly. Skipping
   *    preventDefault leaves the browser's own behaviour for the link intact
   *    rather than swallowing the click into a silent no-op. Anchor CTAs are
   *    kept from reaching this branch at all - the hero renders `#today` only
   *    when DropPanel emits it, and scripts/check-anchors.mjs fails the build on
   *    any in-page href with no matching id - so this is the belt to that brace.
   *  - Target somewhere else on the page: smooth-scroll to it, then flash it.
   *    "Somewhere else" is a scroll distance, not a visibility test - a heading
   *    in the lower half of the screen is already in view and still a useful
   *    scroll away, and article TOC links live on exactly that case.
   *  - Target already where the scroll would land it (the desktop hero, where
   *    the drop panel sits beside the CTA, and the last section of a page the
   *    document cannot scroll any further): flash it in place. */
  const ANCHOR_FLASH_CLASS = 'is-anchor-target';
  const ANCHOR_FLASH_MS = 1200;
  /* Frames of an unchanged scroll position that count as "landed", and the cap
     that ends the wait if the visitor keeps scrolling by hand. */
  const SETTLED_FRAMES = 3;
  const MAX_SETTLE_FRAMES = 120;

  const anchorScrollTop = (el: HTMLElement): number | null =>
    resolveAnchorScrollTop({
      targetTop: el.offsetTop,
      scrollY: window.scrollY,
      maxScrollY:
        document.documentElement.scrollHeight -
        (window.innerHeight || document.documentElement.clientHeight),
    });

  /* Run once the smooth scroll has actually landed. A long jump takes longer
     than the flash lasts, so flashing on click would leave the visitor arriving
     at the target with nothing to see. Polling the scroll position beats
     `scrollend`, which Safari still doesn't have, and settles immediately when
     the scroll turns out to move nothing. */
  const whenScrollSettles = (run: () => void): void => {
    let previous = window.scrollY;
    let unchanged = 0;
    let frames = 0;
    const tick = (): void => {
      unchanged = window.scrollY === previous ? unchanged + 1 : 0;
      previous = window.scrollY;
      if (unchanged >= SETTLED_FRAMES || ++frames >= MAX_SETTLE_FRAMES) run();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href')?.slice(1) ?? '';
      const el = id ? document.getElementById(id) : null;
      if (!el) return;
      e.preventDefault();
      const top = anchorScrollTop(el);
      if (top === null) {
        flashClass(el, ANCHOR_FLASH_CLASS, ANCHOR_FLASH_MS);
        return;
      }
      window.scrollTo({ top, behavior: 'smooth' });
      whenScrollSettles(() => flashClass(el, ANCHOR_FLASH_CLASS, ANCHOR_FLASH_MS));
    });
  });

  /* ---- Share button (Web Share API w/ clipboard fallback) ---- */
  /* A rejection the visitor caused rather than a failure: DOMException named
     AbortError is what a dismissed share sheet or permission prompt produces. */
  const isAbort = (error: unknown): boolean =>
    error instanceof Error && error.name === 'AbortError';

  const flashLabel = (el: HTMLElement, label: string, ms = 1500): void => {
    const prev = el.dataset.flashTitle ?? el.getAttribute('title') ?? '';
    el.dataset.flashTitle = prev;
    el.setAttribute('title', label);
    flashClass(el, 'is-flashed', ms, () => {
      el.setAttribute('title', prev);
      delete el.dataset.flashTitle;
    });
  };

  /* Copy `value`, acknowledge it on `btn`, and fall back to a prompt the visitor
     can copy out of by hand when the clipboard is unavailable (an insecure
     origin, a denied permission, a browser that has no clipboard API).

     The fallback is the reason this is worth reporting: the visitor still gets
     the value, so nothing looks broken from the outside, and without the capture
     a permission policy that silently disables copying on a whole browser would
     never show up anywhere. */
  const copyToClipboard = async (
    btn: HTMLElement,
    value: string,
    promptLabel: string,
    flashedLabel: string,
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      flashLabel(btn, flashedLabel);
    } catch (error) {
      captureError(error, { feature: 'clipboard', screen: screenName });
      window.prompt(promptLabel, value);
    }
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
        } catch (error) {
          /* A dismissed share sheet rejects with AbortError and is a choice, not
             a fault - reporting it would bury the real failures under it. Every
             other rejection is a broken share on this device and is reported. */
          if (!isAbort(error)) captureError(error, { feature: 'web-share', screen: screenName });
        }
      }
      await copyToClipboard(btn, url, 'Copy this link:', 'Link copied');
    });
  });

  /* ---- Copy-link button ---- */
  document.querySelectorAll<HTMLElement>('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      track(EVENTS.copyLinkClicked, screenName ? { screen: screenName } : undefined);
      await copyToClipboard(btn, window.location.href, 'Copy this link:', 'Link copied');
    });
  });

  /* ---- Copy-code button (promo detail) ----
   * The same flash acknowledgement as the copy-link control above, over the
   * promo code rather than the page URL: the code is what the visitor has to
   * carry to the merchant's checkout, and a code that has to be selected by
   * hand is the step the promo funnel was losing people on silently. */
  document.querySelectorAll<HTMLElement>('[data-copy-code]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const code = btn.dataset.copyCode ?? '';
      track(EVENTS.promoCodeCopied, parseProps(btn.dataset.trackProps));
      await copyToClipboard(btn, code, 'Copy this code:', 'Code copied');
    });
  });

  /* ---- Read completion -------------------------------------------------
   * One engagement event per article page view, and only one. It fires when the
   * reader crosses the sentinel at the end of the article body AND has accrued
   * at least READ_ACTIVE_MS of *active* time - time the tab spent in front of
   * them, paused while it is hidden. Either half alone is a poor proxy: a short
   * page is fully scrolled the moment it loads, and a tab left open overnight
   * accrues hours nobody read.
   *
   * Deliberately not a 25/50/75/90 scroll ladder: that is four events per page
   * view measuring page length rather than reader interest.
   *
   * The active-time property is bucketed, never raw milliseconds - a
   * millisecond count is unique per page view and unusable as a dimension. */
  const readSentinel = document.querySelector<HTMLElement>('[data-read-sentinel]');
  if (readSentinel && typeof IntersectionObserver === 'function') {
    const gate = new ReadCompletionGate();
    const activeTime = new ActiveTime(Date.now());
    /* A document restored into a background tab is not being read - start the
       stopwatch paused rather than waiting for the first visibility change. */
    if (document.visibilityState === 'hidden') activeTime.pause(Date.now());
    let reachedEnd = false;
    let pendingCheck: number | null = null;

    const emitIfRead = (): void => {
      const elapsed = activeTime.elapsed(Date.now());
      if (!gate.shouldEmit(elapsed)) return;
      if (pendingCheck !== null) window.clearTimeout(pendingCheck);
      pendingCheck = null;
      track(EVENTS.articleRead, {
        ...(screenName ? { screen: screenName } : {}),
        ...(pageView?.slug ? { slug: pageView.slug } : {}),
        active_time: activeTimeBucket(elapsed),
      });
    };

    /* Reaching the end early is the common case on a short review, so the gate
       is re-checked once the outstanding active time could have elapsed rather
       than being polled. */
    const scheduleCheck = (): void => {
      if (!reachedEnd || pendingCheck !== null) return;
      const remaining = READ_ACTIVE_MS - activeTime.elapsed(Date.now());
      if (remaining <= 0) return;
      pendingCheck = window.setTimeout(() => {
        pendingCheck = null;
        emitIfRead();
        scheduleCheck();
      }, remaining);
    };

    document.addEventListener('visibilitychange', () => {
      const now = Date.now();
      if (document.visibilityState === 'hidden') {
        activeTime.pause(now);
        if (pendingCheck !== null) {
          window.clearTimeout(pendingCheck);
          pendingCheck = null;
        }
      } else {
        activeTime.resume(now);
        scheduleCheck();
      }
    });

    new IntersectionObserver((entries, observer) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      reachedEnd = true;
      gate.reachEnd();
      emitIfRead();
      scheduleCheck();
    }).observe(readSentinel);
  }

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

      /* Building and mounting the overlay touches enough of the DOM - and locks
         document scrolling while it is up - that a failure half way through
         would leave the page unscrollable with nothing on screen to close. The
         guard both reports it and lets the page carry on. */
      const openLightbox = (): void => {
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

      const open = (): void => {
        track(EVENTS.lightboxOpened, screenName ? { screen: screenName } : undefined);
        try {
          openLightbox();
        } catch (error) {
          document.body.style.overflow = '';
          captureError(error, { feature: 'lightbox', screen: screenName });
        }
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
