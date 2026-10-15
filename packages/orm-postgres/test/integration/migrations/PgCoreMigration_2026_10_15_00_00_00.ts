/* eslint-disable @typescript-eslint/no-empty-function */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('postgres')
export class PgCoreMigration_2026_10_15_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('pg_auto_key', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });

    await connection.schema().createTable('pg_uuid_key', (t) => {
      t.string('Id', 36).notNull().primaryKey();
      t.string('Name');
    });

    await connection.schema().createTable('pg_composite_key', (t) => {
      t.int('TenantId').notNull().primaryKey();
      t.string('Code', 32).notNull().primaryKey();
      t.string('Name');
    });

    // table.uuid() is BINARY(16), so BYTEA here; read back through @Uuid()
    await connection.schema().createTable('pg_bytes_uuid', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.uuid('Ref');
    });

    // the schema builder has no native uuid type
    await connection.schema().raw('CREATE TABLE "pg_native_uuid" ("Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "Name" varchar(255))');

    await connection.schema().createTable('pg_person', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name').notNull();
      t.int('Age');
      t.string('City');
    });

    await connection.schema().createTable('pg_pet', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.int('person_id');
      t.foreignKey('person_id').references('pg_person', 'Id');
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
