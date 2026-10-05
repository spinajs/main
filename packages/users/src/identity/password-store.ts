import { Injectable } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';
import { PasswordCredentialStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { USERS_TABLE, exactlyEquals, holdsNoPassword, isNoPassword, raw, rowsAffected, usersDriver } from './sql.js';

const isUser = (id: IdentityRef | undefined): id is IdentityRef => id?.type === 'user' && typeof id.id === 'string';

/**
 * Passwords in `users.Password`, keyed by `user:<Uuid>` (RFC N3-1). `null`, `''` and `NO_PASSWORD` read as no
 * password; any other value, authn-local's `'!expired'` included, reads back verbatim.
 */
@Injectable(PasswordCredentialStore)
export class UserPasswordStore extends PasswordCredentialStore {
  /** `driver`: the connection holding `users`; default the base `User` model's. */
  constructor(protected readonly Deps?: { readonly driver?: OrmDriver }) {
    super();
  }

  public async get(id: IdentityRef): Promise<string | null> {
    if (!isUser(id)) {
      return null;
    }

    const rows = (await this.driver().select().from(USERS_TABLE).columns(['Password']).where('Uuid', id.id)) as { Password?: unknown }[];
    const stored = rows[0]?.Password;
    return isNoPassword(stored) ? null : String(stored);
  }

  /**
   * One statement, never a read followed by a write. `expected` undefined: unconditional, answers true. `null`: only
   * over a stored no-password state. A string: only over exactly that value (see `exactlyEquals` for the collations).
   */
  public async set(id: IdentityRef, hash: string, expected?: string | null): Promise<boolean> {
    if (!isUser(id)) {
      return expected === undefined;
    }

    // `get` never answers these, so no stored value can equal them.
    if (typeof expected === 'string' && isNoPassword(expected)) {
      return false;
    }

    const driver = this.driver();
    try {
      if (expected === undefined) {
        await this.update(driver, id, hash);
        return true;
      }

      if (expected === null) {
        return rowsAffected(await this.update(driver, id, hash).where(raw(holdsNoPassword(driver, 'Password')))) === 1;
      }

      // Writing the stored value again changes nothing, and MySQL without CLIENT_FOUND_ROWS would report 0 rows for
      // it: the answer is whether the stored value is `expected` now.
      if (hash === expected) {
        // Rows, not selectCount(): orm-mssql compiles a count into an invalid OFFSET/FETCH.
        const matched = (await driver.select().from(USERS_TABLE).columns(['Uuid']).where('Uuid', id.id).where(raw(exactlyEquals(driver, 'Password', expected)))) as unknown[];
        return matched.length === 1;
      }

      return rowsAffected(await this.update(driver, id, hash).where(raw(exactlyEquals(driver, 'Password', expected)))) === 1;
    } catch (err) {
      // Driver errors carry the statement and its bindings, the hash among them.
      throw new UnexpectedServerError(`users: could not store the password of user ${id.id} (${(err as Error)?.name ?? typeof err})`);
    }
  }

  protected update(driver: OrmDriver, id: IdentityRef, hash: string) {
    return driver.update().in(USERS_TABLE).update({ Password: hash }).where('Uuid', id.id);
  }

  protected driver(): OrmDriver {
    return this.Deps?.driver ?? usersDriver();
  }
}
