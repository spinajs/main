import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

/**
 * Creates `user_sessions`. `SessionId` holds sha256(raw id) as 64 hex chars; Subject and
 * ImpersonatorId hold principal keys (indexed for A08 / SR-06). `State` has no default: a default
 * `'active'` would activate a row that never passed 2FA (SR-07). `UserId` is nullable, so its
 * ON DELETE CASCADE does not end 3.0 sessions.
 *
 * The timestamp is later than `@spinajs/users`'s `RBACInitial_2022_06_28_01_13_00`: the foreign
 * key references `users`, and on one connection the migrations run in timestamp order.
 */
@Migration('session-provider-connection')
export class UserSessionDBSqlMigration_2022_06_28_01_20_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('user_sessions', (table) => {
      table.string('SessionId', 64).primaryKey().notNull();
      table.dateTime('CreatedAt').notNull();
      table.dateTime('Expiration');
      table.json('Data').notNull();
      table.int('UserId');
      table.string('Subject', 100);
      table.string('ImpersonatorId', 100);
      table.string('State', 16);

      table.foreignKey('UserId').references('users', 'Id').onDelete(ReferentialAction.Cascade);
    });

    // Explicit, or the sqlite driver cannot read the unique index back from sqlite_master.
    await connection.index().table('user_sessions').name('session_id_user_session_idx').columns(['SessionId']).unique();
    await connection.index().table('user_sessions').name('user_sessions_subject_idx').columns(['Subject']);
    await connection.index().table('user_sessions').name('user_sessions_impersonator_idx').columns(['ImpersonatorId']);
  }

  // tslint:disable-next-line: no-empty
  public async down(_: OrmDriver): Promise<void> {}
}
