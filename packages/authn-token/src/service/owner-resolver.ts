import { Injectable } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { AccessToken } from '../models/AccessToken.js';

/** Maps a token owner to `rbac_access_tokens.user_id` and back. */
export abstract class TokenOwnerResolver {
  /** The row id the owner's tokens carry, or null for an owner this resolver does not know. */
  abstract rowIdOf(owner: IdentityRef): Promise<number | null>;

  abstract refOf(rowId: number): Promise<IdentityRef | null>;
}

/**
 * Owners are users: `users.Uuid` ↔ `users.Id`. Reads the table directly so that this package does not
 * import `@spinajs/users`.
 */
@Injectable(TokenOwnerResolver)
export class UsersTableTokenOwnerResolver extends TokenOwnerResolver {
  public async rowIdOf(owner: IdentityRef): Promise<number | null> {
    if (owner?.type !== 'user' || typeof owner.id !== 'string' || owner.id.length === 0) {
      return null;
    }

    const row = (await this.connection().select().from('users').columns(['Id']).where({ Uuid: owner.id }).first()) as { Id: number } | undefined;
    return row ? Number(row.Id) : null;
  }

  public async refOf(rowId: number): Promise<IdentityRef | null> {
    const row = (await this.connection().select().from('users').columns(['Uuid']).where({ Id: rowId }).first()) as { Uuid: string } | undefined;
    return row ? { type: 'user', id: row.Uuid } : null;
  }

  protected connection(): OrmDriver {
    const driver = AccessToken.getModelDescriptor().Driver;
    if (!driver) {
      throw new Error('The AccessToken model has no database connection; is the orm resolved?');
    }
    return driver;
  }
}
