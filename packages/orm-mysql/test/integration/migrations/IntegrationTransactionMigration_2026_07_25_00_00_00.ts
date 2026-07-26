/* eslint-disable @typescript-eslint/no-empty-function */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('mysql')
export class IntegrationTransactionMigration_2026_07_25_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // InnoDB, not MyISAM — MyISAM ignores transactions entirely and every rollback
    // assertion in the suite would silently pass for the wrong reason.
    await connection.schema().createTable('integration_user', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Name').notNull();
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
