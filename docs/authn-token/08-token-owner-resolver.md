# Token owner resolver

`TokenOwnerResolver` maps a token owner (`IdentityRef`) to the `rbac_access_tokens.user_id` row id and back. The default, `UsersTableTokenOwnerResolver`, maps users through the `users` table. Replace or extend it when your owners are keyed differently.

## How it works

1. `DbTokenService.create`, `list`, `revoke` and `revokeAllFor` call `rowIdOf(owner)`:
   - `UsersTableTokenOwnerResolver` answers `null` unless `owner.type` is `user` and `owner.id` a non-empty string.
   - It selects `Id` from `users` where `Uuid = owner.id`, and answers that id or `null`.
2. `create` throws for a `null` row id; `list` answers `[]`, `revoke` `false` and `revokeAllFor` `0`.
3. `DbTokenService.revokeById` calls `refOf(user_id)`:
   - The default selects `Uuid` from `users` where `Id = user_id` and answers `{ type: 'user', id: Uuid }`, or `null`.
4. `DbTokenService.validate` calls `tokenByHash(hash)` on a cache miss. It answers the token row and its owner, or `null` for an unknown hash:
   - The base class reads the row, then calls `refOf`: two statements.
   - `UsersTableTokenOwnerResolver` reads both in one statement, a `LEFT JOIN` of `users` on `user_id`.
5. `validate` fails the token (`invalid_credentials`) when the owner is `null`; `revokeById` publishes its event without an identity.

The default reads the `users` table directly, so this package does not import `@spinajs/users`. The protected `connection()` takes the `AccessToken` model's connection (`default` unless the model names another) with `modelDriver(AccessToken)`; when the ORM has no such connection it throws `OrmConnectionMissing`. `rowIdOf()` and `refOf()` await `ormReady()` first instead of injecting `Orm`, so they also work from a boot migration's `data()`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Owner resolver | `TokenOwnerResolver`; singleton; `@Injectable(TokenOwnerResolver)` when the package loads; injected into `DbTokenService`'s `Owners` property | `UsersTableTokenOwnerResolver` | none | Subclass `UsersTableTokenOwnerResolver` (override `rowIdOf`, `refOf`, `tokenByHash` or the protected `connection()`) or `TokenOwnerResolver`, and register it with `@Injectable(TokenOwnerResolver)` before `TokenService` is first resolved. |

### Owner resolver: custom implementation

Every row id must be a `users.Id`: `user_id` has a foreign key to `users`. A custom resolver therefore changes how owners are named, not where tokens live. The example lets service accounts, stored as `users` rows with `IsService = 1`, own tokens as `{ type: 'service', id: Uuid }`.

```ts sample
import { TokenOwnerResolver, UsersTableTokenOwnerResolver } from '@spinajs/authn-token';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';

/** Users and service accounts share the users table; the IsService column tells them apart. */
@Injectable(TokenOwnerResolver)
export class ServiceAccountTokenOwnerResolver extends UsersTableTokenOwnerResolver {
  public async rowIdOf(owner: IdentityRef): Promise<number | null> {
    if ((owner?.type !== 'user' && owner?.type !== 'service') || typeof owner.id !== 'string' || owner.id.length === 0) {
      return null;
    }
    const row = (await this.connection()
      .select()
      .from('users')
      .columns(['Id'])
      .where({ Uuid: owner.id, IsService: owner.type === 'service' ? 1 : 0 })
      .first()) as { Id: number } | undefined;
    return row ? Number(row.Id) : null;
  }

  public async refOf(rowId: number): Promise<IdentityRef | null> {
    const row = (await this.connection().select().from('users').columns(['Uuid', 'IsService']).where({ Id: rowId }).first()) as { Uuid: string; IsService: number } | undefined;
    return row ? { type: Number(row.IsService) === 1 ? 'service' : 'user', id: row.Uuid } : null;
  }
}
```

Your `IdentityStore.status` must then answer for `service` identities too, since `validate` asks it about every owner.

`UsersTableTokenOwnerResolver.tokenByHash` names every owner `user` and does not call `refOf`. A subclass that changes how owners are named, like the one above, must also override `tokenByHash`; the simplest override is the base class's two-statement version:

```ts sample
import { AccessToken, UsersTableTokenOwnerResolver } from '@spinajs/authn-token';
import type { TokenWithOwner } from '@spinajs/authn-token';

export class TwoStatementOwnerResolver extends UsersTableTokenOwnerResolver {
  public async tokenByHash(hash: string): Promise<TokenWithOwner | null> {
    const token = await AccessToken.where('Token', hash).first();
    return token ? { token, owner: await this.refOf(token.user_id) } : null;
  }
}
```

## Important behaviour

- **`tokenByHash` and `refOf` must agree.** `validate` names the owner `tokenByHash` answers; `revokeById` and the audit name the one `refOf` answers.
- **`rowIdOf` and `refOf` must agree.** `refOf(rowIdOf(owner))` must give back the same owner; otherwise `revoke` and the audit name another identity than `validate` answers.
- **Revocation is owner-bound through the resolver.** `revoke` matches the token's `user_id` against `rowIdOf(owner)`, so a resolver that maps two owners to one row lets each revoke the other's tokens.
- **Must be registered.** `DbTokenService` injects the resolver with the strict check (`{ check: true }`), so resolving it fails when no `TokenOwnerResolver` is registered.
- **Agent tokens use the owner's row.** An agent token carries its owner's `user_id`; there is no separate agent row.

## Related

- [Issuing and revoking tokens](01-token-service.md): every call that maps an owner.
- [Token storage and migrations](05-token-storage.md#rbac_access_tokens): the `user_id` column and its foreign key.
- [`@spinajs/users` identity store](../users/07-identity-and-password-stores.md): the `IdentityStore` that answers the owner's status.
