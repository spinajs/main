import { Autoinject, Injectable } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';
import { PasswordAgeSource } from '@spinajs/authn-local';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { runAsSystem } from '../system.js';
import { USERS_TABLE, holdsPassword, quoted, raw, usersDriver } from './sql.js';

/**
 * Ages from `users.PasswordSetAt`, which `UserPasswordStateHook` writes after a real password set.
 * A NULL beside a password is a lost write, and its unknown age counts as old.
 */
@Injectable(PasswordAgeSource)
export class UserPasswordAgeSource extends PasswordAgeSource {
  /** Never read: injecting it resolves the Orm, which binds the `User` model, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  constructor(protected readonly Deps?: { readonly driver?: OrmDriver }) {
    super();
  }

  /** Users not deleted, holding a password (not a marker), set before `cutoff` or at no recorded time. */
  public async passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]> {
    const rows = (await runAsSystem('password-age', async () => {
      const driver = this.Deps?.driver ?? usersDriver();
      const setAt = quoted(driver, 'PasswordSetAt');
      return driver
        .select()
        .from(USERS_TABLE)
        .columns(['Uuid'])
        .where(raw({ sql: `(${setAt} IS NULL OR ${setAt} < ?)`, bindings: [cutoff] }))
        .whereNull('DeletedAt')
        .where(raw(holdsPassword(driver, 'Password')));
    })) as { Uuid: unknown }[];

    return rows.map((r) => ({ type: 'user', id: String(r.Uuid) }));
  }
}
