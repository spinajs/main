/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';
import _ from 'lodash';

@Migration('default')
export class RBACInitial_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('users', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.uuid('Uuid').notNull();
      table.string('Email', 64).unique().notNull();
      table.string('Password', 128).notNull();
      table.string('Login', 64).notNull();
      table.string('Role', 256).notNull();
      table.boolean('IsActive').notNull().default().value(0);
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('DeletedAt');
      table.dateTime('LastLoginAt');
    });

    await connection.schema().createTable('users_metadata', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Key', 255).notNull();
      table.enum('Type', ['number', 'float', 'string', 'json', 'boolean', 'datetime']).notNull();
      table.text('Value');
      table.int('user_id').notNull();
      table.foreignKey('user_id').references('users', 'Id').cascade();
    });

    await connection.index().unique().table('users').name('user_uuid_idx').columns(['Uuid']);
    await connection.index().unique().table('users_metadata').name('owner_user_meta_key_idx').columns(['user_id', 'Key']);
    await connection.index().unique().table('users').name('user_login_idx').columns(['Login']);
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver): Promise<void> {}
}
