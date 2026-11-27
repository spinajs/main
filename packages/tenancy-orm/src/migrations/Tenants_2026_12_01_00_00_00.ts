import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';

const COLUMNS = ['suspension', 'lifecycle_epoch', 'lifecycle_until', 'lifecycle_owner', 'lifecycle'];

/**
 * The steps of a tenant's provisioning or deletion (`lifecycle`, JSON) and the lease of the operation that runs them.
 * The suspension has a column of its own: suspend() does not wait for the lease, and the lease holder rewrites `lifecycle`.
 */
@Migration(TENANCY_CONNECTION)
export class Tenants_2026_12_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // SQLite adds one column per ALTER TABLE.
    await connection.schema().alterTable(TENANTS_TABLE, (table) => {
      table.text('lifecycle');
    });
    await connection.schema().alterTable(TENANTS_TABLE, (table) => {
      table.text('suspension');
    });
    await connection.schema().alterTable(TENANTS_TABLE, (table) => {
      table.string('lifecycle_owner', 64);
    });
    await connection.schema().alterTable(TENANTS_TABLE, (table) => {
      table.bigint('lifecycle_until');
    });
    await connection.schema().alterTable(TENANTS_TABLE, (table) => {
      table.int('lifecycle_epoch').notNull().default().value(0);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const column of COLUMNS) {
      await connection.schema().alterTable(TENANTS_TABLE, (table) => {
        table.dropColumn(column);
      });
    }
  }
}
