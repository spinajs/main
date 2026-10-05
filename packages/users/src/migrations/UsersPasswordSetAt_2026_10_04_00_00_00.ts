import { IdentifierQuoter, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

import { USERS_TABLE, holdsPassword, raw, sqlDateTime } from '../identity/sql.js';

const COLUMN = 'PasswordSetAt';

/**
 * Adds the nullable `users.PasswordSetAt` that `UserPasswordAgeSource` reads (authn-local's password expiry).
 *
 * Rows holding a password get the migration time, not null and not `CreatedAt`: when an application later turns
 * `authn.local.expiration.enabled` on, the passwords that predate the column age from the upgrade instead of all
 * expiring on the first run. Rows without a password (an invite, a marker) stay null and are never listed.
 */
@Migration('default')
export class UsersPasswordSetAt_2026_10_04_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    const columns = await connection.tableInfo(USERS_TABLE);

    if (!columns?.some((c) => c.Name === COLUMN)) {
      await connection.schema().alterTable(USERS_TABLE, (table) => {
        table.dateTime(COLUMN);
      });
    }

    await connection
      .update()
      .in(USERS_TABLE)
      .update({ [COLUMN]: sqlDateTime(new Date()) })
      .whereNull(COLUMN)
      .where(raw(holdsPassword(connection, 'Password')));
  }

  public async down(connection: OrmDriver): Promise<void> {
    const q = connection.Container.resolve(IdentifierQuoter);
    // The ORM's dropColumn() emits the name unquoted, which Postgres folds to lower case.
    await connection.schema().raw(`ALTER TABLE ${q.quote(USERS_TABLE)} DROP COLUMN ${q.quote(COLUMN)}`);
  }
}
