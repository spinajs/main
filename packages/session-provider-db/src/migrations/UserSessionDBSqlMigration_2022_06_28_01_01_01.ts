import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('session-provider-connection')
export class UserSessionDBSqlMigration_2022_06_28_01_01_01 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user_sessions', (table) => {
      table.string('SessionId', 36).primaryKey().notNull();
      table.dateTime('CreatedAt').notNull();
      table.dateTime('Expiration');
      table.json('Data').notNull();
    });

    // create index explicit, otherwise sqlite driver cannot extract unique index from sqlite_master
    await connection.index().table('user_sessions').name('session_id_user_session_idx').columns(['SessionId']).unique();
  }

  // tslint:disable-next-line: no-empty
  public async down(_: OrmDriver): Promise<void> {}
}
