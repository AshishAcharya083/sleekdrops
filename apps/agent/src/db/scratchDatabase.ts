// Databases of a test's own on the Postgres server DATABASE_URL names, for a
// db test that cannot use the shared, fully migrated one from testDb.ts: an
// upgrade test that starts at an older migration, or a platform's separate
// content database. Import it statically, so it reads the server's URL before
// the test points DATABASE_URL at its scratch database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { probeDatabase, SKIP_REASON } from './testProbe.js';

const serverUrl = process.env.DATABASE_URL ?? '';

export const reachable = serverUrl !== '' && (await probeDatabase(serverUrl));
export const skip: string | false = reachable ? false : SKIP_REASON;

export interface ScratchDatabase {
  readonly name: string;
  readonly url: string;
  create(): Promise<void>;
  drop(): Promise<void>;
}

/** A uniquely named database on the test server; nothing exists until create(). */
export function scratchDatabase(prefix: string): ScratchDatabase {
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(serverUrl || 'postgres://localhost/unused');
  url.pathname = `/${name}`;
  return {
    name,
    url: url.href,
    create: () => onServer(`CREATE DATABASE "${name}"`),
    drop: () => onServer(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

async function onServer(sql: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: serverUrl, max: 1 });
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}
