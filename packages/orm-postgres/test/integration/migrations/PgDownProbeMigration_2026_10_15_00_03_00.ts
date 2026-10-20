import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('postgres')
export class PgDownProbeMigration_2026_10_15_00_03_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('pg_down_probe', (t) => {
      t.int('Id').primaryKey().autoIncrement();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('pg_down_probe');
  }
}
