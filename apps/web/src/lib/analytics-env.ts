/**
 * The build-time configuration of the DevTeam analytics sink: the ingest key and
 * the host to send to, plus the deployment policy that keeps the sink out of
 * production.
 *
 * It is a module of its own because it is the one part of `./analytics` that
 * cannot exist outside a Vite build - `import.meta.env` is inlined at build time
 * and does not exist under the bare `node --test` runner. Keeping it behind this
 * boundary is what lets the regression suite import the real analytics module and
 * substitute these two values, instead of re-implementing the module's behaviour
 * in order to test it.
 *
 * Read lazily rather than captured in module constants, so a substituted value
 * applies however the module was loaded.
 */

import { deploymentOf, type SiteDeployment } from './site-env.ts';
import type { ConsentStatus } from './consent.ts';

export interface AnalyticsEnv {
  /**
   * DevTeam Analytics ingest key (dtp_...). Empty disables the DevTeam sink;
   * production always resolves this to empty even if one is supplied.
   */
  key: string;
  /**
   * Ingest host. Defaults to the local analytics platform for a configured
   * non-production build.
   */
  host: string;
  /**
   * Whether the SDK renders its in-app feedback widget - a floating button that
   * screenshots the page, lets the visitor annotate it and sends the report to
   * the analytics project.
   *
   * Opted into per environment rather than following the ingest key, because
   * unlike everything else here it is a visible control on the page, not a
   * silent sink. Off unless the build sets the variable to the exact string
   * `true`, which is also the SDK's own default.
   */
  feedback: boolean;
  /** The no-record analytics decision for this build. */
  defaultConsent: ConsentStatus;
}

export interface AnalyticsEnvInput {
  key?: string;
  host?: string;
  feedback?: string;
}

const LOCAL_HOST = 'http://localhost:6080';

/**
 * Resolve the DevTeam sink configuration for one deployment.
 *
 * Production refuses the sink even if a key is supplied accidentally. A
 * configured preview starts anonymous analytics without prompting; an explicit
 * stored opt-out and browser privacy signals are still enforced by analytics.ts.
 */
export function resolveAnalyticsEnv(
  deployment: SiteDeployment,
  input: AnalyticsEnvInput,
): AnalyticsEnv {
  const configuredKey = input.key?.trim() ?? '';
  const enabled = deployment === 'preview' && configuredKey !== '';
  return {
    key: enabled ? configuredKey : '',
    host: enabled ? input.host?.trim() || LOCAL_HOST : '',
    feedback: enabled && input.feedback === 'true',
    defaultConsent: enabled ? 'granted' : 'denied',
  };
}

const env = import.meta.env as ImportMetaEnv | undefined;

/** This build's analytics configuration. */
export function analyticsEnv(): AnalyticsEnv {
  return resolveAnalyticsEnv(deploymentOf(env?.PUBLIC_SITE_ENV), {
    key: env?.PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY,
    host: env?.PUBLIC_DEVTEAM_ANALYTICS_HOST,
    feedback: env?.PUBLIC_DEVTEAM_ANALYTICS_FEEDBACK,
  });
}
