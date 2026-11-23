import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { TENANCY_CONNECTION, TENANTS_TABLE } from '../connection.js';

// `domains` is a @Set() list and `placement` / `settings` are JSON, all three kept as text. `id`, `slug` and
// `domains` are `exact()`: MySQL's default collation would otherwise match them case- and accent-insensitively.
@Migration(TENANCY_CONNECTION)
export class Tenants_2026_11_16_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(TENANTS_TABLE, (table) => {
      table.string('id', 64).primaryKey().notNull().exact();
      table.string('slug', 64).notNull().unique().exact();
      table.string('name', 128).notNull();
      table.string('state', 16).notNull();
      table.text('domains').notNull().exact();
      table.text('placement');
      table.text('settings').notNull();
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
    });
    await connection.index().table(TENANTS_TABLE).name('tenants_state').columns(['state']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(TENANTS_TABLE);
  }
}
