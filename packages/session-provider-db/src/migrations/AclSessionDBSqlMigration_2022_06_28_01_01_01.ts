import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default')
export class AclSessionDBSqlMigration_2022_06_28_01_01_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('acl_sessions', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('SessionId', 255).notNull();
      table.date('CreatedAt').notNull();
      table.date('Expiration').notNull();
      table.text('Data').notNull();
    });

    // create index explicit, otherwise sqlite driver cannot extract unique index from sqlite_master
    await connection.index().table('acl_sessions').name('session_id_acl_session_idx').columns(['SessionId']).unique();
  }

  // tslint:disable-next-line: no-empty
  public async down(_: OrmDriver): Promise<void> {}
}
