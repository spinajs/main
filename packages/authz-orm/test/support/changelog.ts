import { AuthzChangeLog_2026_11_04_00_00_00, CHANGE_LOG_TABLE, POLICY_VERSION_TABLE } from '../../src/changelog/index.js';
import type { Dialect, TestDb } from './db.js';

async function dropTables(db: TestDb, dialect: Dialect): Promise<void> {
  for (const table of [CHANGE_LOG_TABLE, POLICY_VERSION_TABLE]) await db.raw(`DROP TABLE IF EXISTS "${table}"`, [], dialect);
}

/** Runs the changelog migration on `dialect` and points the alias `authz` there. */
export async function createChangeLogTables(db: TestDb, dialect: Dialect): Promise<void> {
  await dropTables(db, dialect);
  await new AuthzChangeLog_2026_11_04_00_00_00().up(db.driver(dialect));
  await db.useAuthz(dialect);
}

export async function dropChangeLogTables(db: TestDb, dialect: Dialect): Promise<void> {
  await dropTables(db, dialect);
  await db.useAuthz('sqlite');
}
