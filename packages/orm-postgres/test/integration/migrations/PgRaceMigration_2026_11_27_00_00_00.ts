import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('postgres')
export class PgRaceMigration_2026_11_27_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('CREATE TABLE "race_item" ("Id" int PRIMARY KEY, "Grp" text NOT NULL, "Name" text NOT NULL)');
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().raw('DROP TABLE "race_item"');
  }
}
