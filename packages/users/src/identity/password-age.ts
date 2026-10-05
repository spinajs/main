import { Injectable } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';
import { PasswordAgeSource } from '@spinajs/authn-local';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { USERS_TABLE, holdsPassword, quoted, raw, sqlDateTime, usersDriver } from './sql.js';

/**
 * Ages from `users.PasswordSetAt`, which `UserAccountSink` writes on the authn events of a real password set.
 * Rows the column was added to while holding a password count from the migration (`UsersPasswordSetAt_…`), so a
 * NULL beside a password means a lost write, and its unknown age counts as old.
 */
@Injectable(PasswordAgeSource)
export class UserPasswordAgeSource extends PasswordAgeSource {
  constructor(protected readonly Deps?: { readonly driver?: OrmDriver }) {
    super();
  }

  /** Users not deleted, holding a password (not a marker), set before `cutoff` or at no recorded time. */
  public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
    const driver = this.Deps?.driver ?? usersDriver();
    const setAt = quoted(driver, 'PasswordSetAt');
    const rows = (await driver
      .select()
      .from(USERS_TABLE)
      .columns(['Uuid'])
      .where(raw({ sql: `(${setAt} IS NULL OR ${setAt} < ?)`, bindings: [sqlDateTime(cutoff)] }))
      .whereNull('DeletedAt')
      .where(raw(holdsPassword(driver, 'Password')))) as { Uuid: unknown }[];

    return rows.map((r) => ({ type: 'user', id: String(r.Uuid) }));
  }
}
