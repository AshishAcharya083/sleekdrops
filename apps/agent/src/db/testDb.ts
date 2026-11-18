// The database every agent .db.test.ts runs against: whether it answers, the
// reason a suite skips when it does not, and the schema migrated before the
// first test. Import it dynamically, after the test has set the environment
// its subject reads, like the pool itself.
import { migrate } from './migrate.js';
import { pool } from './pool.js';

export const reachable = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

export const skip: string | false = reachable ? false : 'no reachable DATABASE_URL - start Postgres to run these';

if (reachable) await migrate();
