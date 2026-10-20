import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

/**
 * Creates `user_sessions`. `SessionId` holds sha256(raw id) as 64 hex chars; Subject and
 * ImpersonatorId hold principal keys (indexed for A08 / SR-06). `State` has no default: a default
 * `'active'` would activate a row that never passed 2FA (SR-07).
 */
@Migration('session-provider-connection')
export class UserSessionDBSqlMigration_2022_06_28_01_20_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user_sessions', (table) => {
      table.string('SessionId', 64).primaryKey().notNull();
      table.dateTime('CreatedAt').notNull();
      table.dateTime('Expiration');
      table.json('Data').notNull();
      table.string('Subject', 100);
      table.string('ImpersonatorId', 100);
      table.string('State', 16);
    });

    // Explicit, or the sqlite driver cannot read the unique index back from sqlite_master.
    await connection.index().table('user_sessions').name('session_id_user_session_idx').columns(['SessionId']).unique();
    await connection.index().table('user_sessions').name('user_sessions_subject_idx').columns(['Subject']);
    await connection.index().table('user_sessions').name('user_sessions_impersonator_idx').columns(['ImpersonatorId']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('user_sessions');
  }
}
