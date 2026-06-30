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

const token = import.meta.env.PUBLIC_Mixpanel__ProjectToken;

let ready = false;

/**
 * Initialise Mixpanel once. Safe to call on every page load - repeat calls
 * after the first are ignored. A missing/empty token is a deliberate no-op so
 * environments without analytics (local, preview) just skip tracking.
 */
export function init(): void {
  if (ready || !token) return;
  mixpanel.init(token, { track_pageview: true, persistence: 'localStorage' });
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
