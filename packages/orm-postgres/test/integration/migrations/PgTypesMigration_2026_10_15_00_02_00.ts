/* eslint-disable @typescript-eslint/no-empty-function */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('postgres')
export class PgTypesMigration_2026_10_15_00_02_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('pg_typed', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.json('Data');
      t.boolean('Flag');
      t.decimal('Price', 12, 2);
      t.bigint('Big');
      t.enum('Kind', ['draft', 'live']);
      t.binary('Payload', 16);
      t.double('Ratio');
    });

    await connection.schema().createTable('pg_event', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
      t.dateTime('At');
      t.dateTime('CreatedAt').default().dateTime();
      t.date('Day');
    });

    await connection.schema().createTable('pg_account', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Email', 190).notNull().unique();
      t.string('Name');
    });

    await connection.schema().createTable('pg_setting', (t) => {
      t.string('Name', 64).notNull().primaryKey();
      t.string('Value');
    });

    await connection.schema().createTable('pg_tx_user', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name').notNull();
    });

    await connection.schema().createTable('pg_soft', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Val');
      t.dateTime('DeletedAt');
    });

    await connection.schema().createTable('pg_lease', (t) => {
      t.string('Name', 64).notNull().primaryKey();
      t.string('Owner');
      t.dateTime('LeaseUntil');
      t.int('Version').notNull().default().value(0);
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
