// Whether an agent db test has a Postgres to run against, and the reason its
// suite skips when it does not. Importing this connects to nothing and
// migrates nothing, so a test that builds a database of its own can use it.
import pg from 'pg';

export const SKIP_REASON = 'no reachable DATABASE_URL - start Postgres to run these';

/** Whether Postgres answers at `connectionString`; empty means pg's PG* defaults, as the agent's pool does. */
export async function probeDatabase(connectionString: string): Promise<boolean> {
  const probe = new pg.Pool(connectionString ? { connectionString, max: 1 } : { max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}
