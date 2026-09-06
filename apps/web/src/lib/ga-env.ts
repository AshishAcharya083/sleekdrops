/**
 * The build-time configuration of the Google Analytics 4 sink: the measurement
 * id of the property this environment reports into.
 *
 * A module of its own for the same reason `./analytics-env`, `./flags-env` and
 * `./ads-env` are - `import.meta.env` is inlined by Vite at build time and does
 * not exist under the bare `node --test` runner - which is what lets the
 * regression suite drive the real `./ga` module against a stand-in property
 * instead of re-implementing it in order to test it.
 *
 * Read lazily rather than captured in module constants, so a substituted value
 * applies however the module was loaded.
 */

export interface GaEnv {
  /**
   * GA4 measurement id (`G-...`). Empty - which is also what a value that is not
   * a measurement id reads as, see `measurementId` - disables the GA4 sink
   * silently, exactly as an empty ingest key disables the DevTeam sink and an
   * empty publisher id disables ads.
   */
  id: string;
}

const env = import.meta.env as ImportMetaEnv | undefined;

/**
 * The only shape a measurement id may take: `G-` and the uppercase alphanumeric
 * container id a GA4 web data stream mints.
 *
 * Validated and not merely trimmed, for the reason `publisherId` in `./ads-env`
 * is validated: a wrong-shaped value names no property gtag.js can report into,
 * so loading the tag for it produces a page that looks healthy while Google
 * discards every hit. A typo, a pasted stream id (`G-` is not `GT-` and neither
 * is a numeric `measurement id` from Universal Analytics) or a value from the
 * wrong environment therefore disables GA4 exactly the way an empty variable
 * does - with the one `[analytics]` warning `./ga` prints for it, which is
 * findable, rather than by silently measuring nothing.
 *
 * Case is not corrected, only checked. A lowercase id is refused with that same
 * warning instead of being upcased into a property that may not exist, on the
 * principle the rest of this family follows: a value we cannot be sure of is not
 * quietly repaired into one we can.
 */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

/** A configured measurement id, or `''` for a build that has none to use. */
export function measurementId(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return MEASUREMENT_ID_PATTERN.test(value) ? value : '';
}

/** This build's GA4 configuration. */
export function gaEnv(): GaEnv {
  return { id: measurementId(env?.PUBLIC_GA4_ID) };
}
