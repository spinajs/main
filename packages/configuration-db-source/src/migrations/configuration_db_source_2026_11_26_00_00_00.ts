import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/**
 * `Scope`: 'shared' for a shared row, `tenant:<id>` for a row of one tenant. A slug is unique per scope. Not '': the
 * ORM refuses a model write while a required column holds ''.
 */
@Migration('default')
export class configuration_db_source_2026_11_26_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('configuration', (table) => {
      table.string('Scope', 80).notNull().default().value('shared');
    });
    await connection.index().drop().name('configuration_unique_slug').table('configuration');
    await connection.index().unique().table('configuration').name('configuration_unique_slug_scope').columns(['Slug', 'Scope']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.del().from('configuration').where('Scope', '!=', 'shared');
    await connection.index().drop().name('configuration_unique_slug_scope').table('configuration');
    await connection.schema().alterTable('configuration', (table) => {
      table.dropColumn('Scope');
    });
    await connection.index().unique().table('configuration').name('configuration_unique_slug').columns(['Slug']);
  }
}
