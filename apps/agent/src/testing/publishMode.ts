// Serialising the one global setting the test suite moves.
//
// `node --test` runs each *.db.test.ts in its own process, in parallel,
// against one Postgres, and `publish_mode` is a single row in `settings` that
// getSetting() reads straight out of the database - there is no per-process
// scope to isolate it in. So a file that flips the mode to 'draft' for one
// assertion flips it for whatever another file is doing at that moment, and
// the refusals keyed on the mode start answering requests that expected to be
// served.
//
// The advisory lock below is the shared thing all of those processes already
// have. A file that moves the mode takes it exclusively for the window it
// needs; a file whose assertions depend on the configured mode holds it shared
// for its whole run. Neither file has to know the other exists, and the suite
// stops depending on how the runner happens to schedule them.
import { getSetting, pool, setSetting } from '../db/pool.js';

/** Arbitrary but stable, and the same number in every process: 'PUBM'. */
const PUBLISH_MODE_LOCK = 0x5055424d;

/**
 * A session-level advisory lock outlives the query that took it, so it is held
 * on one checked-out client and must be unlocked before that client goes back
 * to the pool - a connection returned still holding it would hand the lock to
 * whatever borrows it next.
 */
async function lockedClient(lock: 'pg_advisory_lock' | 'pg_advisory_lock_shared') {
  const client = await pool.connect();
  try {
    await client.query(`SELECT ${lock}($1::bigint)`, [PUBLISH_MODE_LOCK]);
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    client,
    async release(): Promise<void> {
      const unlock = lock === 'pg_advisory_lock' ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared';
      try {
        await client.query(`SELECT ${unlock}($1::bigint)`, [PUBLISH_MODE_LOCK]);
      } finally {
        client.release();
      }
    },
  };
}

/** Run `body` with publish_mode set, and put the setting back afterwards. */
export async function withPublishMode<T>(mode: string, body: () => Promise<T>): Promise<T> {
  const held = await lockedClient('pg_advisory_lock');
  try {
    const previous = await getSetting<string>('publish_mode', 'approval');
    await setSetting('publish_mode', mode);
    try {
      return await body();
    } finally {
      await setSetting('publish_mode', previous);
    }
  } finally {
    await held.release();
  }
}

/**
 * Hold publish_mode as the database has it for as long as the caller needs it
 * - a whole test file, acquired beside its `migrate()`. Returns the release,
 * which the file's `after()` hook must call before it ends the pool.
 */
export async function holdPublishMode(): Promise<() => Promise<void>> {
  const held = await lockedClient('pg_advisory_lock_shared');
  return () => held.release();
}
