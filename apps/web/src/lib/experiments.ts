/**
 * Experiments - the single entry point for A/B testing, and the only module in
 * the site that touches the GrowthBook SDK (mirroring the chokepoint discipline
 * `./analytics` applies to the DevTeam Analytics SDK).
 *
 * Flags and experiments are authored in the DevTeam A/B Testing tab and served
 * in GrowthBook's payload format from `<apiHost>/api/features/<clientKey>`; the
 * SDK fetches that payload and evaluates every rule locally, so a feature read
 * is synchronous and costs no request.
 *
 * Four properties this module has to guarantee:
 *
 *  1. **Consent first, and only for as long as it lasts.** Nothing is fetched,
 *     bucketed or tracked until `start()` is called, and `./analytics` only
 *     calls it from the consent-grant path. The SDK itself is loaded with a
 *     dynamic import inside `start()`, so on a declined or GPC/DNT visit its
 *     code never even reaches the browser. `stop()` is the other half: the
 *     withdrawal path calls it, and it takes down everything the grant started -
 *     stream, poll, instance and stamps - in the same page load.
 *  2. **One identity.** `attributes.id` is the distinct id the DevTeam
 *     analytics SDK reports for this visitor, passed in by the caller. Bucketing
 *     and measurement have to join on the same key; any other value fails
 *     silently and every experiment reads 0%.
 *  3. **Fail safe.** A missing key, an unreachable platform, an offline visitor
 *     or a wrong-typed payload all yield the caller's code-side default, with no
 *     thrown error and no visual error state.
 *  4. **The payload is data, never code.** It is read over https on a secure
 *     page (see `isFlagHostAllowed`) and evaluated with GrowthBook's
 *     auto-experiments off, so a flag can only change a value the site itself
 *     asked for - never run script, rewrite the DOM or redirect the visitor.
 *
 * All console lines are prefixed `[analytics]` via the injected logger, so
 * experiment activity filters alongside the rest of the telemetry.
 */

import type { GrowthBook } from '@growthbook/growthbook';

// Explicit .ts extensions: unlike ./analytics this module is loaded directly by
// the node --test runner (see experiments.test.ts), which needs real specifiers.
import { flagsEnv, type FlagsEnv } from './flags-env.ts';
import { EXPERIMENT_PROP_PREFIX, isExperimentStamp, type EventProps } from './pii.ts';

/**
 * Upper bound on how long an already-open tab can keep serving a stale payload.
 * Streaming (SSE) normally pushes a change within a second; this poll is the
 * fallback for browsers, proxies and networks where the stream does not hold,
 * and it is what makes "toggle a flag, see it within a minute" true rather than
 * "see it on the next page load".
 */
const REFRESH_MS = 60_000;

/** How long the first payload fetch may block before we fall back to defaults. */
const INIT_TIMEOUT_MS = 3_000;

/**
 * Upper bound on how many sticky stamps are retained. The names come from the
 * flag payload, so without a cap a bad or hostile payload could grow both
 * localStorage and every outgoing analytics payload without limit. A visitor in
 * more than this many live experiments at once is a misconfiguration.
 */
const MAX_STICKY_PROPS = 32;

export type ExperimentLogLevel = 'info' | 'warn';

export interface ExperimentHooks {
  /** Called once per experiment the visitor is exposed to, with its variant. */
  onExposure(experimentKey: string, variantKey: string): void;
  /** Console + platform logging, injected so this module stays sink-agnostic. */
  log(level: ExperimentLogLevel, message: string): void;
  /**
   * Report a handled failure with its stack trace. Injected for the same reason
   * as `log`: this module must stay sink-agnostic and importable by the bare
   * `node --test` runner, which cannot resolve the analytics SDK.
   *
   * Every failure here is silent by design - a feature that cannot be read falls
   * back to its code-side default and the page renders unchanged - which is
   * exactly why it has to be reported: without this, an unreachable flag host
   * looks identical to an experiment nobody converted on.
   */
  captureError(error: unknown, attributes?: EventProps): void;
}

/** localStorage key holding the sticky stamps, alongside `sd-consent`/`sd-theme`. */
const STICKY_KEY = 'sd-exp';

/**
 * Whether the flag payload may be fetched from `host` on a page served over
 * `pageProtocol`.
 *
 * The payload drives what the page renders and how visitors are bucketed, and it
 * is neither signed nor encrypted, so on a secure page it may only be read over
 * a channel a network intermediary cannot rewrite. A plaintext host is allowed
 * only when the page itself is plaintext - local development against a mock or
 * an internal platform, where there is no secure channel to downgrade from.
 *
 * Refusing rather than trying is also the honest failure: the browser blocks a
 * http:// fetch from a https:// page as mixed content, so the alternative is
 * every feature silently reading its default while the site looks healthy.
 */
export function isFlagHostAllowed(host: string, pageProtocol: string): boolean {
  try {
    return new URL(host).protocol === 'https:' || pageProtocol !== 'https:';
  } catch {
    return false;
  }
}

let growthbook: GrowthBook | null = null;
let started = false;
/**
 * The hooks of the current start()/stop() cycle. Held at module level because a
 * feature read - and so a failure worth reporting - happens long after start()
 * returns, from a subscriber in chrome.ts that has no reference to them. Named
 * apart from `load`'s own `hooks` parameter so the two are never confused: this
 * one is null before a grant and again after a withdrawal, which is exactly what
 * keeps a post-withdrawal read from reporting anything.
 */
let activeHooks: ExperimentHooks | null = null;
/** Handle on the staleness poll below, so a withdrawal can stop it. */
let refreshTimer: number | null = null;
/**
 * Which start()/stop() cycle the in-flight load belongs to. A withdrawal can land
 * while the SDK chunk or its first payload fetch is still in the air, and what
 * arrives after it must not become this document's live instance: it would carry
 * the stream and the tracking callback back past the moment the visitor said stop.
 */
let run = 0;
const subscribers = new Set<() => void>();
const sticky: EventProps = {};

/**
 * The `$exp_<experimentKey>` = `<variantKey>` stamp for every experiment this
 * visitor has been bucketed into. `./analytics` merges it into every outgoing
 * event and log, which is what attributes a conversion to a variant without any
 * call site having to know an experiment exists.
 */
export function stickyProps(): EventProps {
  return sticky;
}

function remember(experimentKey: string, variantKey: string): void {
  const prop = EXPERIMENT_PROP_PREFIX + experimentKey;
  if (!isExperimentStamp(prop, variantKey)) return;
  if (!(prop in sticky) && Object.keys(sticky).length >= MAX_STICKY_PROPS) return;
  sticky[prop] = variantKey;
  try {
    localStorage.setItem(STICKY_KEY, JSON.stringify(sticky));
  } catch {
    /* storage unavailable - the stamp still applies for this page load */
  }
}

/**
 * Reload the stamps written on an earlier page load. Necessary because this is a
 * multi-page static site: a visitor is bucketed on the page that reads a feature
 * and converts on a later page that never does, and the navigation in between is
 * a full reload. Called from the consent-grant path only, so nothing is read
 * back for a visitor who has not opted in.
 */
export function restoreStickyProps(): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STICKY_KEY) ?? 'null');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const [key, value] of Object.entries(stored)) {
      if (!isExperimentStamp(key, value)) continue;
      if (Object.keys(sticky).length >= MAX_STICKY_PROPS) break;
      sticky[key] = value;
    }
  } catch {
    /* storage unavailable or corrupt - stamps then hold for this page only */
  }
}

/** Forget every assignment, in memory and on disk. Called on a consent decline. */
export function clearStickyProps(): void {
  Object.keys(sticky).forEach((key) => delete sticky[key]);
  try {
    localStorage.removeItem(STICKY_KEY);
  } catch {
    /* storage unavailable - nothing is sent on a decline anyway */
  }
}

function notify(): void {
  subscribers.forEach((apply) => {
    try {
      apply();
    } catch (error) {
      // One bad subscriber must not stop the others re-rendering - and a slot
      // that silently keeps its control copy looks exactly like a variant that
      // did not win, so the failure is reported rather than dropped.
      activeHooks?.captureError(error, { feature: 'experiments-apply' });
    }
  });
}

/**
 * Narrow a value from the flag payload to the caller's type. A missing,
 * wrong-typed or blank value can never replace the code-side default, so a
 * half-written or stale payload degrades to the shipped copy rather than to an
 * empty button.
 */
export function coerceFeatureValue<T>(raw: unknown, defaultValue: T): T {
  if (typeof raw !== typeof defaultValue) return defaultValue;
  if (typeof raw === 'string' && raw.trim() === '') return defaultValue;
  return raw as T;
}

/**
 * Read a feature value, falling back to `defaultValue` whenever the payload is
 * absent, not yet loaded or unusable. Evaluating a feature that an experiment
 * rule covers is what exposes the visitor to it, so this is also what triggers
 * the tracking callback.
 */
export function getFeatureValue<T extends string | number | boolean>(
  key: string,
  defaultValue: T,
): T {
  if (!growthbook) return defaultValue;
  try {
    return coerceFeatureValue(growthbook.getFeatureValue(key, defaultValue), defaultValue);
  } catch (error) {
    activeHooks?.captureError(error, { feature: 'experiments-read' });
    return defaultValue;
  }
}

/**
 * Register a callback that applies feature values to the DOM. It runs once
 * immediately (so a caller wires itself up against the defaults) and again on
 * every payload change - the initial fetch, a streamed update, or a poll.
 */
export function subscribe(apply: () => void): void {
  subscribers.add(apply);
  try {
    apply();
  } catch (error) {
    // A subscriber that throws on its first run must not break page setup. This
    // one runs before the consent grant that calls start(), so there are no
    // hooks yet and nothing is reported - which is the correct outcome: no
    // telemetry may leave the browser before the visitor has opted in.
    activeHooks?.captureError(error, { feature: 'experiments-apply' });
  }
}

async function load(distinctId: string, hooks: ExperimentHooks, env: FlagsEnv): Promise<void> {
  const thisRun = run;
  // Dynamically imported so the SDK is only downloaded once a visitor has opted
  // in - a declined or GPC/DNT visit never fetches this chunk at all.
  const { GrowthBook } = await import('@growthbook/growthbook');
  if (run !== thisRun) return;

  const instance = new GrowthBook({
    apiHost: env.apiHost,
    clientKey: env.clientKey,
    // The site reads primitive feature values and nothing else. GrowthBook's
    // auto-experiments are on by default and would let a payload run
    // `script.innerHTML = <js>` in the page or navigate the visitor away via
    // window.location.replace(), turning the A/B Testing tab (and anyone who can
    // tamper with the payload) into a script-injection and open-redirect surface
    // on the public site. Turn off the capabilities we do not use.
    disableVisualExperiments: true,
    disableJsInjection: true,
    disableUrlRedirectExperiments: true,
    attributes: { id: distinctId },
    trackingCallback: (experiment, result) => {
      const variantKey = String(result.key);
      // Stamp first, so the exposure event itself carries the variant too.
      remember(experiment.key, variantKey);
      hooks.onExposure(experiment.key, variantKey);
    },
  });
  instance.setRenderer(notify);
  growthbook = instance;

  const { success, error } = await instance.init({
    streaming: true,
    timeout: INIT_TIMEOUT_MS,
  });
  // init() is what opens the stream, so a withdrawal that landed while it was in
  // flight found nothing to close: this instance has to take itself down.
  if (run !== thisRun) {
    teardown(instance);
    return;
  }
  if (!success) {
    hooks.log(
      'warn',
      'A/B testing payload unavailable - features fall back to their code-side defaults: ' +
        String(error ?? 'timed out'),
    );
    // The fetch or the parse of the flag payload failed. It degrades silently on
    // the page, so the stack trace is the only way the failure is ever seen.
    hooks.captureError(error ?? new Error('A/B testing payload fetch timed out'), {
      feature: 'experiments-payload',
    });
  } else {
    hooks.log('info', 'A/B testing initialized -> ' + env.apiHost);
  }
  notify();

  refreshTimer = window.setInterval(() => {
    // skipCache forces a network read, so the poll is a real upper bound on
    // staleness rather than a no-op against a still-fresh cache entry.
    instance.refreshFeatures({ skipCache: true }).catch((error: unknown) => {
      // Offline or platform down - the last known payload (or the defaults)
      // stands, so the page is unaffected and only this report says so.
      hooks.captureError(error, { feature: 'experiments-refresh' });
    });
  }, REFRESH_MS);
}

/**
 * Take one instance down: its subscription to the flag host closed, its payload
 * released, no callback of ours left reachable from it.
 *
 * `destroyAllStreams` is what actually closes the SSE connection. Without it
 * `destroy()` only unsubscribes this instance from the stream, and the stream -
 * which the SDK keeps in module-level state keyed by host and client key, not on
 * the instance - stays open and connected to the flag host with nobody listening.
 * The site creates exactly one instance per document, so "all streams" is ours.
 */
function teardown(instance: GrowthBook): void {
  instance.destroy({ destroyAllStreams: true });
}

/**
 * Start evaluating experiments for this visitor. Called only from the consent-
 * grant path in `./analytics`, and only ever once per page.
 *
 * `distinctId` must be the id the DevTeam analytics SDK reports, so exposure and
 * conversion join on the same key.
 */
export function start(distinctId: string, startHooks: ExperimentHooks): void {
  if (started) return;
  started = true;
  activeHooks = startHooks;
  const env = flagsEnv();
  if (!env.clientKey || !env.apiHost) {
    startHooks.log(
      'warn',
      'A/B testing NOT configured - PUBLIC_DEVTEAM_FLAGS_CLIENT_KEY / PUBLIC_DEVTEAM_FLAGS_HOST are empty',
    );
    return;
  }
  if (!isFlagHostAllowed(env.apiHost, location.protocol)) {
    startHooks.log(
      'warn',
      'A/B testing disabled - PUBLIC_DEVTEAM_FLAGS_HOST must be a valid https:// URL on a secure page: ' +
        env.apiHost,
    );
    return;
  }
  load(distinctId, startHooks, env).catch((error: unknown) => {
    // Telemetry must never be able to break the site it measures: on any
    // failure every feature simply keeps its code-side default - but the SDK
    // chunk failing to load is invisible on the page, so it is reported.
    startHooks.log('warn', 'A/B testing disabled - SDK failed to initialise: ' + String(error));
    startHooks.captureError(error, { feature: 'experiments-init' });
  });
}

/**
 * Stop A/B testing where it stands. Called from the consent-withdrawal path in
 * `./analytics`, alongside the two analytics sinks' own stops.
 *
 * Everything `start()` set running has to go, because withdrawal is reachable
 * from the footer control long after the grant that started it: the subscription
 * to the flag host, the staleness poll, and - above all - the instance itself.
 * Dropping the instance is what makes every later feature read return its
 * code-side default, and so what keeps the tracking callback from bucketing the
 * visitor, stamping a fresh `sd-exp` and emitting an exposure after they opted
 * out. A read after a withdrawal is a routine event rather than a corner case:
 * `chrome.ts` re-reads every experiment-backed slot on each payload change and
 * on every crossing of the nav breakpoint.
 *
 * The stamps go last, once nothing is left that could write one back.
 *
 * Leaves `started` false, so a visitor who opts back in on the same page is
 * bucketed again rather than silently left out of every experiment - the same
 * reason the GA4 opt-out flag is cleared on a re-grant.
 */
export function stop(): void {
  run += 1;
  started = false;
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  const instance = growthbook;
  growthbook = null;
  activeHooks = null;
  if (instance) teardown(instance);
  clearStickyProps();
}
