import { Autoinject, Injectable } from '@spinajs/di';
import { IdentifierQuoter, Orm, RawQuery } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { _is_string, _non_empty, _try_check_arg } from '@spinajs/util';
import { InvalidOperation } from '@spinajs/exceptions';

import { AccessToken } from '../models/AccessToken.js';

const USERS_TABLE = 'users';
const USER_ID = 'Id';
const USER_UUID = 'Uuid';
const OWNER_ALIAS = '$token_owner$';
/** Not a column of the model, so the hydrator leaves it as a plain property of the row. */
const OWNER_UUID = '$OwnerUuid';

/** A token row and its owner; `owner` is null when the owner is gone. */
export interface TokenWithOwner {
  readonly token: AccessToken;
  readonly owner: IdentityRef | null;
}

/** Maps a token owner to `rbac_access_tokens.user_id` and back. */
export abstract class TokenOwnerResolver {
  /** The row id the owner's tokens carry, or null for an owner this resolver does not know. */
  abstract rowIdOf(owner: IdentityRef): Promise<number | null>;

  abstract refOf(rowId: number): Promise<IdentityRef | null>;

  /** The token stored under `hash` with its owner. Override it to read both in one statement. */
  public async tokenByHash(hash: string): Promise<TokenWithOwner | null> {
    const token = await AccessToken.where('Token', hash).first();
    return token ? { token, owner: await this.refOf(token.user_id) } : null;
  }
}

/**
 * Owners are users: `users.Uuid` ↔ `users.Id`. Reads the table directly so that this package does not
 * import `@spinajs/users`.
 */
@Injectable(TokenOwnerResolver)
export class UsersTableTokenOwnerResolver extends TokenOwnerResolver {
  @Autoinject(Orm)
  protected Orm: Orm;

  public async rowIdOf(owner: IdentityRef): Promise<number | null> {
    const [ok, uuid] = _try_check_arg(_is_string(_non_empty()))(owner?.id, 'owner.id');
    if (owner?.type !== 'user' || !ok) {
      return null;
    }

    const row = (await this.connection().select().from(USERS_TABLE).columns([USER_ID]).where({ [USER_UUID]: uuid }).first()) as { [USER_ID]: number } | undefined;
    return row ? Number(row[USER_ID]) : null;
  }

  public async refOf(rowId: number): Promise<IdentityRef | null> {
    const row = (await this.connection().select().from(USERS_TABLE).columns([USER_UUID]).where({ [USER_ID]: rowId }).first()) as { [USER_UUID]: string } | undefined;
    return row ? { type: 'user', id: row[USER_UUID] } : null;
  }

  public async tokenByHash(hash: string): Promise<TokenWithOwner | null> {
    const connection = this.connection();
    const quoter = connection.Container.resolve(IdentifierQuoter);
    // The model builder selects only its own columns; the owner's Uuid comes in as a raw, dialect-quoted column.
    const ownerUuid = new RawQuery(`${quoter.quote(OWNER_ALIAS)}.${quoter.quote(USER_UUID)} AS ${quoter.quote(OWNER_UUID)}`);
    const token = await AccessToken.where('Token', hash)
      .select(ownerUuid)
      .leftJoin({ joinTable: USERS_TABLE, joinTableAlias: OWNER_ALIAS, joinTableForeignKey: USER_ID, sourceTablePrimaryKey: 'user_id', joinTableDriver: connection })
      .first();
    if (!token) {
      return null;
    }
    const uuid = (token as unknown as Record<string, unknown>)[OWNER_UUID];
    return { token, owner: typeof uuid === 'string' && uuid.length > 0 ? { type: 'user', id: uuid } : null };
  }

  /** The connection of the token rows, whose `user_id` points into the users table. */
  protected connection(): OrmDriver {
    const name = AccessToken.getModelDescriptor().Connection ?? 'default';
    const driver = this.Orm.Connections.get(name);
    if (!driver) {
      throw new InvalidOperation(`No database connection ${name} for the users table`);
    }
    return driver;
  }
}
