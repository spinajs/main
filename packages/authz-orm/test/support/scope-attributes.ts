import { AuthzScopeAttribute_2026_10_02_00_00_00, SCOPE_ATTRIBUTE_TABLE, SCOPE_ATTRIBUTE_VERSION_TABLE } from '../../src/scope-attributes/index.js';
import type { Dialect, TestDb } from './db.js';

async function dropTables(db: TestDb, dialect: Dialect): Promise<void> {
  for (const table of [SCOPE_ATTRIBUTE_VERSION_TABLE, SCOPE_ATTRIBUTE_TABLE]) await db.raw(`DROP TABLE IF EXISTS "${table}"`, [], dialect);
}

/** Runs the migration on `dialect` (the version row included) and points the alias `authz` there. */
export async function createScopeAttributeTables(db: TestDb, dialect: Dialect): Promise<void> {
  await dropTables(db, dialect);
  await new AuthzScopeAttribute_2026_10_02_00_00_00().up(db.driver(dialect));
  await db.useAuthz(dialect);
}

export async function dropScopeAttributeTables(db: TestDb, dialect: Dialect): Promise<void> {
  await dropTables(db, dialect);
  await db.useAuthz('sqlite');
}
