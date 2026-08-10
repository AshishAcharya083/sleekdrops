/**
 * The build-time configuration of the A/B testing sink: the flag-delivery host
 * and this environment's client key.
 *
 * It is a module of its own for the same reason `./analytics-env` is one -
 * `import.meta.env` is inlined by Vite at build time and does not exist under the
 * bare `node --test` runner. Keeping the two values behind this boundary is what
 * lets the regression suite drive the real `./experiments` module, and the real
 * GrowthBook SDK, against a stand-in flag host instead of re-implementing the
 * module's behaviour in order to test it.
 *
 * Read lazily rather than captured in module constants, so a substituted value
 * applies however the module was loaded.
 */

export interface FlagsEnv {
  /**
   * Flag-delivery host. Empty disables experiments silently after one warning,
   * exactly as an empty ingest key disables the DevTeam analytics sink.
   */
  apiHost: string;
  /** GrowthBook client key for this environment. Empty disables experiments. */
  clientKey: string;
}

const env = import.meta.env as ImportMetaEnv | undefined;

/** This build's A/B testing configuration. */
export function flagsEnv(): FlagsEnv {
  return {
    apiHost: env?.PUBLIC_DEVTEAM_FLAGS_HOST ?? '',
    clientKey: env?.PUBLIC_DEVTEAM_FLAGS_CLIENT_KEY ?? '',
  };
}
