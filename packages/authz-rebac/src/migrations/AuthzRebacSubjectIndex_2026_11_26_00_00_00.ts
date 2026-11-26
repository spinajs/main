import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmException, OrmMigration, RawQuery, sqlDialectOf } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

const TABLE = 'authz_rebac_tuple';
const INDEX = 'authz_rebac_tuple_subject_object';

/** Serves `DbTupleStore.withSubjectObject`, which `scope.forget` runs on every delete of an `@AccessResource` row. */
@Migration(AUTHZ_CONNECTION)
export class AuthzRebacSubjectIndex_2026_11_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // On a large PostgreSQL table an operator may build it by hand first, with CONCURRENTLY, so writes go on meanwhile.
    if (await hasIndex(connection)) {
      await assertValid(connection);
      return;
    }
    await connection.index().table(TABLE).name(INDEX).columns(['subject_type', 'subject_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (await hasIndex(connection)) await connection.index().table(TABLE).name(INDEX).drop();
  }
}

async function hasIndex(connection: OrmDriver): Promise<boolean> {
  return (await connection.tableIndexes?.(TABLE))?.some((i) => i.name === INDEX) ?? false;
}

/**
 * A failed or cancelled `CREATE INDEX CONCURRENTLY` leaves an invalid index that the planner never uses. Throws rather
 * than rebuilding: a concurrent build still in progress reads invalid too. MySQL and SQLite have no such state; a
 * disabled MSSQL index is not checked.
 */
async function assertValid(connection: OrmDriver): Promise<void> {
  if (sqlDialectOf(connection.constructor as abstract new (...args: never[]) => unknown)?.grammar !== 'PostgresQL') return;
  // to_regclass resolves the name through search_path, which the driver sets to the connection's schema.
  const rows = await connection.select<{ indisvalid: boolean }[]>().from('pg_index').columns(['indisvalid']).where(RawQuery.create('indexrelid = to_regclass(?)', [INDEX]));
  if (rows[0]?.indisvalid === false) {
    throw new OrmException(`${INDEX} exists but is INVALID (a failed or cancelled CREATE INDEX CONCURRENTLY): run DROP INDEX CONCURRENTLY ${INDEX}; then build it again by hand or let this migration build it`);
  }
}
