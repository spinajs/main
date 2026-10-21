import { Injectable } from '@spinajs/di';
import { modelDriver, ormReady } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { _is_string, _non_empty, _try_check_arg } from '@spinajs/util';

import { AccessToken } from '../models/AccessToken.js';

const USERS_TABLE = 'users';
const USER_ID = 'Id';
const USER_UUID = 'Uuid';

/** Maps a token owner to `rbac_access_tokens.user_id` and back. */
export abstract class TokenOwnerResolver {
  /** The row id the owner's tokens carry, or null for an owner this resolver does not know. */
  abstract rowIdOf(owner: IdentityRef): Promise<number | null>;

  abstract refOf(rowId: number): Promise<IdentityRef | null>;
}

/**
 * Owners are users: `users.Uuid` ↔ `users.Id`. Reads the table directly so that this package does not
 * import `@spinajs/users`.
 *
 * Waits for the Orm per call instead of injecting it: a boot migration that seeds users or tokens runs inside the
 * Orm's resolve, and an injected Orm would wait for that resolve to finish.
 */
@Injectable(TokenOwnerResolver)
export class UsersTableTokenOwnerResolver extends TokenOwnerResolver {
  public async rowIdOf(owner: IdentityRef): Promise<number | null> {
    const [ok, uuid] = _try_check_arg(_is_string(_non_empty()))(owner?.id, 'owner.id');
    if (owner?.type !== 'user' || !ok) {
      return null;
    }

    await ormReady();
    const row = (await this.connection().select().from(USERS_TABLE).columns([USER_ID]).where({ [USER_UUID]: uuid }).first()) as { [USER_ID]: number } | undefined;
    return row ? Number(row[USER_ID]) : null;
  }

  public async refOf(rowId: number): Promise<IdentityRef | null> {
    await ormReady();
    const row = (await this.connection().select().from(USERS_TABLE).columns([USER_UUID]).where({ [USER_ID]: rowId }).first()) as { [USER_UUID]: string } | undefined;
    return row ? { type: 'user', id: row[USER_UUID] } : null;
  }

  /** The connection of the token rows, whose `user_id` points into the users table. */
  protected connection(): OrmDriver {
    return modelDriver(AccessToken);
  }
}
