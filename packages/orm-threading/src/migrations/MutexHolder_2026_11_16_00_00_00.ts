import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class MutexHolder_2026_11_16_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Tenant', 32).rename('Holder');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('__mutex__', (table) => {
      table.string('Holder', 32).rename('Tenant');
    });
  }
}
