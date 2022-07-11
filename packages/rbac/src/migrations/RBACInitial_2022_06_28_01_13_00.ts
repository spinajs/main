/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class RBACInitial_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('users', (table) => {
      table.uuid('Id').notNull().primaryKey();
      table.string('Email', 64).unique().notNull();
      table.string('Password', 128).notNull();
      table.string('NiceName', 64).notNull();
      table.string('Role', 256).notNull();
      table.dateTime('RegisteredAt');
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('DeletedAt');
    });

    await connection.schema().createTable('users_metadata', (table) => {
      table.int('Id').autoIncrement().primaryKey();
      table.string('Key', 255).notNull();
      table.text('Value').notNull();
      table.uuid('user_id').notNull();
      table.foreignKey('user_id').references('users', 'Id').cascade();
    });

    await connection.index().unique().table('users_metadata').name('owner_user_meta_key_idx').columns(['user_id', 'Key']);
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
