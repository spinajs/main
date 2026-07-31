import { Migration, OrmMigration, OrmDriver, ReferentialAction } from '@spinajs/orm';

/**
 * Creates the `user_sessions` table.
 *
 * The timestamp is deliberately later than `@spinajs/rbac`'s `RBACInitial_2022_06_28_01_13_00`,
 * because the foreign key below references `users`, which that migration creates. When
 * `session-provider-connection` is an alias of the default connection - the usual setup, and what
 * `db.Aliases` exists for - both migrations resolve to the same `OrmDriver`, so
 * `MigrationRunner.plan()` collapses them into one group and runs them in timestamp order. This
 * migration previously carried the timestamp `2022_06_28_01_01_01`, twelve minutes *before*
 * `RBACInitial`, so on an empty database it ran first and failed with `ER_FK_CANNOT_OPEN_PARENT` -
 * the parent table did not exist yet.
 *
 * Renaming a migration is normally unsafe, because the applied-migration row records the class name
 * and a renamed class looks like a new, unapplied one. Two things make it safe here:
 *
 *   - the migration service builds its pending list as registered-minus-applied and never looks an
 *     applied row up in the registry, so the row left behind under the old name is simply ignored
 *   - the guard below makes a re-run a no-op, so a database that already has the table records this
 *     migration as applied without touching anything
 *
 * No `migration resolve` step is therefore needed on existing deployments.
 */
@Migration('session-provider-connection')
export class UserSessionDBSqlMigration_2022_06_28_01_20_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // Databases that applied this migration under its old name already have the table. Returning
    // here is what lets the rename cost nothing on an existing deployment.
    if (await connection.schema().tableExists('user_sessions')) {
      return;
    }

    await connection.schema().createTable('user_sessions', (table) => {
      table.string('SessionId', 36).primaryKey().notNull();
      table.dateTime('CreatedAt').notNull();
      table.dateTime('Expiration');
      // TEXT, not JSON. This is what every deployed `user_sessions` actually has: the migration
      // created `Data` as `table.text(...)` from its first version (2022-06-28) until commit
      // b8bd2acb7 ("ver bump", 2024-06-18) flipped it to `table.json(...)` in passing. The guard
      // above means that flip has never run against an existing database, so it only ever changed
      // what FRESH installs get - and a fresh install then had a session it could not read back,
      // because mysql2 returns a JSON column already parsed while the model and the codec both
      // deal in strings. Fresh installs now match deployed reality again.
      table.text('Data').notNull();
      table.int('UserId').notNull();

      table.foreignKey('UserId').references('users', 'Id').onDelete(ReferentialAction.Cascade);
    });

    // create index explicit, otherwise sqlite driver cannot extract unique index from sqlite_master
    await connection.index().table('user_sessions').name('session_id_user_session_idx').columns(['SessionId']).unique();
  }

  // tslint:disable-next-line: no-empty
  public async down(_: OrmDriver): Promise<void> {}
}
