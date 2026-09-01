/**
 * The build-time configuration of the DevTeam analytics sink: the ingest key and
 * the host to send to.
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

export interface AnalyticsEnv {
  /**
   * DevTeam Analytics ingest key (dtp_...). Empty disables the DevTeam sink
   * silently, exactly as an empty flags client key disables experiments.
   */
  key: string;
  /**
   * Ingest host. Defaults to the local analytics platform; set
   * PUBLIC_DEVTEAM_ANALYTICS_HOST to https://ingest.getdevteam.ai in production.
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
}

const env = import.meta.env as ImportMetaEnv | undefined;

/** This build's analytics configuration. */
export function analyticsEnv(): AnalyticsEnv {
  return {
    key: env?.PUBLIC_DEVTEAM_ANALYTICS_INGEST_KEY ?? '',
    host: env?.PUBLIC_DEVTEAM_ANALYTICS_HOST ?? 'http://localhost:6080',
    feedback: env?.PUBLIC_DEVTEAM_ANALYTICS_FEEDBACK === 'true',
  };
}
