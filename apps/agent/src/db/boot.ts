// Boot-time database wait. Containers start in no guaranteed order, so a
// refused connection in the first minute is a race worth sitting out, not a
// misconfiguration. A misconfiguration still kills the process - but naming
// the address that was actually dialled and the variables that set it, which
// is exactly what the old hardcoded `localhost:5544` default hid.
import { migrate } from './migrate.js';
import { describeTarget } from './pool.js';

export interface WaitPolicy {
  firstDelayMs: number;
  maxDelayMs: number;
  /** Total time spent sleeping between attempts before giving up. */
  budgetMs: number;
}

/** 1s doubling to 10s, ~55s of waiting over 8 attempts. */
export const DEFAULT_WAIT_POLICY: WaitPolicy = {
  firstDelayMs: 1_000,
  maxDelayMs: 10_000,
  budgetMs: 60_000,
};

/**
 * Errors that mean "not there yet" rather than "wrong": nothing listening
 * yet, a service hostname DNS has not published yet, or a server still
 * starting up (57P03 = cannot_connect_now).
 */
const NOT_READY_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', '57P03']);

/**
 * Errors that mean the process is pointed at the wrong place: a host that
 * swallows the connection, or a server that answers but rejects this identity
 * (28000/28P01) or does not have this database (3D000). Retrying cannot help,
 * but naming the wiring can.
 */
const MISCONFIGURED_CODES = new Set(['ETIMEDOUT', 'EAI_AGAIN', '28000', '28P01', '3D000']);

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the operator has to change, whichever way the target turned out wrong. */
const WIRING_HINT =
  'Set DATABASE_URL (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) to the database ' +
  "this process should use. In a container that is the database container's service " +
  "hostname on port 5432 - not localhost, and not 5544, which exists only as " +
  "docker-compose's host-side mapping for local development.";

/**
 * Apply migrations, tolerating a database that is not up yet: a connection
 * that is merely not ready is retried with exponential backoff inside
 * `policy.budgetMs`. Any other failure, or an exhausted budget, throws - and
 * boot fails loudly, with the resolved target in the message.
 */
export async function migrateWhenReady(policy: WaitPolicy = DEFAULT_WAIT_POLICY): Promise<void> {
  let delayMs = policy.firstDelayMs;
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      return;
    } catch (err) {
      const target = describeTarget();
      const code = codeOf(err);
      if (MISCONFIGURED_CODES.has(code)) {
        throw new Error(`cannot use the postgres at ${target}. ${WIRING_HINT}`, { cause: err });
      }
      if (!NOT_READY_CODES.has(code)) {
        throw new Error(`migration against postgres at ${target} failed`, { cause: err });
      }
      if (waitedMs + delayMs > policy.budgetMs) {
        const waitedSeconds = Math.round(waitedMs / 1000);
        throw new Error(
          `postgres at ${target} did not answer after ${attempt} attempts over ` +
            `${waitedSeconds}s. ${WIRING_HINT}`,
          { cause: err },
        );
      }
      console.log(`[agent] waiting for postgres at ${target} (attempt ${attempt})`);
      await sleep(delayMs);
      waitedMs += delayMs;
      delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
    }
  }
}
