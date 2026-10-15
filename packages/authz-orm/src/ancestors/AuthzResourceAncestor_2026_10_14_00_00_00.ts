import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';

/**
 * authz_resource_ancestor (design §4.1): one row per proper ancestor of a resource, no self row and no
 * $global row. On 'default' like the RBAC tables: the list query joins it with them and with the resource tables.
 */
@Migration('default')
export class AuthzResourceAncestor_2026_10_14_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(AUTHZ_RESOURCE_ANCESTOR_TABLE, (table) => {
      table.string('resource_type', 64).notNull().primaryKey();
      table.string('resource_id', 64).notNull().primaryKey();
      table.string('ancestor_type', 64).notNull().primaryKey();
      table.string('ancestor_id', 64).notNull().primaryKey();
      table.int('depth').notNull();
    });
    await connection.index().table(AUTHZ_RESOURCE_ANCESTOR_TABLE).name('authz_resource_ancestor_up').columns(['ancestor_type', 'ancestor_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(AUTHZ_RESOURCE_ANCESTOR_TABLE).ifExists();
  }
}
