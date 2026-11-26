import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

const TABLE = 'authz_rebac_tuple';
const INDEX = 'authz_rebac_tuple_subject_object';

/** Serves `DbTupleStore.withSubjectObject`, which `scope.forget` runs on every delete of an `@AccessResource` row. */
@Migration(AUTHZ_CONNECTION)
export class AuthzRebacSubjectIndex_2026_11_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // On a large PostgreSQL table an operator may build it by hand first, with CONCURRENTLY, so writes go on meanwhile.
    const present = await connection.tableIndexes?.(TABLE);
    if (present?.some((i) => i.name === INDEX)) return;
    await connection.index().table(TABLE).name(INDEX).columns(['subject_type', 'subject_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.index().table(TABLE).name(INDEX).drop();
  }
}
