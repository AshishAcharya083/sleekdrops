/**
 * Analytics - the single entry point for product tracking.
 *
 * Wraps mixpanel-browser so tracking calls never touch the SDK directly:
 * the token lives in config, init runs once client-side from chrome.ts, and
 * every call is a safe no-op until init() has succeeded. When the token is
 * empty (local/dev, or analytics disabled) nothing loads and nothing throws.
 */

import mixpanel from 'mixpanel-browser';

export type EventProps = Record<string, unknown>;

/**
 * The product event taxonomy. Every track call uses one of these names so the
 * vocabulary stays consistent between code and docs/analytics-events.md - the
 * doc is the canonical reference for properties and owning screens.
 */
export const EVENTS = {
  pageView: 'Page Viewed',
  heroCtaClick: 'Hero CTA Clicked',
  dealCardClick: 'Deal Card Clicked',
  affiliateClick: 'Affiliate Link Clicked',
  newsletterSignup: 'Newsletter Signup',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const token = import.meta.env.PUBLIC_Mixpanel__ProjectToken;

let ready = false;

/**
 * Initialise Mixpanel once. Safe to call on every page load - repeat calls
 * after the first are ignored. A missing/empty token is a deliberate no-op so
 * environments without analytics (local, preview) just skip tracking.
 *
 * Page views are emitted explicitly (see EVENTS.pageView) with screen/category
 * context, so the SDK's contextless auto-pageview is turned off to avoid a
 * second, redundant page-view event.
 *
 * Funnel-step events are fired from click handlers immediately before the
 * browser navigates (deal cards, affiliate "View deal" buttons). Batching would
 * queue those events and lose them on unload, so it's disabled and requests go
 * out via sendBeacon, which survives the page transition.
 */
export function init(): void {
  if (ready || !token) return;
  mixpanel.init(token, {
    track_pageview: false,
    persistence: 'localStorage',
    batch_requests: false,
    api_transport: 'sendBeacon',
  });
  ready = true;
}

/**
 * Record an event. No-op until init() has run with a valid token, so callers
 * never need to guard their tracking calls.
 */
export function track(event: string, props?: EventProps): void {
  if (!ready) return;
  mixpanel.track(event, props);
}
