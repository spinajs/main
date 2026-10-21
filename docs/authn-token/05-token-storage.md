# Token storage and migrations

API tokens live in the `rbac_access_tokens` table, mapped by the `AccessToken` model on the `default` connection. The package ships two migrations: one creates the table, one adds the columns a rotation uses.

## How it works

1. Importing `@spinajs/authn-token` loads `AccessToken` (`@Model('rbac_access_tokens')`, `@Connection('default')`) and the migration (`@Migration('default')`).
2. The ORM finds the migration in the DI registry (`DiRegistryMigrationSource`), not by a scan of `system.dirs.migrations`: the package config deliberately ships no migration or model directory. See [Migrations](../orm/10-migrations.md).
3. `RbacHttpTokenInitial_2026_08_11_01_00_00` runs in timestamp order with the other packages' migrations, after the one that creates `users`. It creates the table with every column and the four indexes.
4. `AuthnTokenRotation_2026_10_21_00_00_00` adds `PreviousToken` and `PreviousValidUntil` and a unique index on `PreviousToken`.
5. `DbTokenService` reads and writes the table through `AccessToken`; see [Issuing and revoking tokens](01-token-service.md).

## Configuration

The model and the migration read no configuration key. The table uses the `default` connection; see [Connections](../orm/01-connections.md).

## Schema

### `rbac_access_tokens`

| Column | Type | Meaning |
| --- | --- | --- |
| `Id` | `int`, primary key, auto increment | Internal row id; hidden from `dehydrate()` and never returned. |
| `Uuid` | `varchar(36)`, not null, unique | Public token id: `TokenRecord.id`, the route and CLI argument. A random UUID v4 when not given. |
| `Name` | `varchar(128)`, not null | Label, for example `ci deploy`. |
| `Token` | `varchar(64)`, not null, unique | SHA-256 hex digest of the plaintext. Hidden from `dehydrate()`. |
| `Roles` | `varchar(512)`, not null | Comma-joined role ceiling (`@Set()`); empty for none. |
| `Profile` | `varchar(128)`, nullable | The role the token is pinned to. |
| `ExpiresAt` | `datetime`, nullable, indexed | Absolute expiry. `DbTokenService.create` always sets it; a row with `NULL` is refused as expired. |
| `CreatedAt` | `datetime`, not null, default now | Set from `ctx.now` by `DbTokenService.create`. |
| `LastUsedAt` | `datetime`, nullable | Last successful use, written at most once per `authn.token.lastUsedUpdateInterval`. |
| `user_id` | `int`, not null, indexed, foreign key to `users.Id` with cascade | Owner row; hidden from `dehydrate()`. |
| `Scope` | `text`, nullable | JSON `TokenScope` (`permissions`, `resources`, `agent`); `NULL` for no limits. |
| `Kind` | `varchar(16)`, not null, default `'pat'` | `pat`, `service` or `agent`. |
| `RevokedAt` | `datetime`, nullable | Set by a revoke; the row stays until swept. |
| `LastUsedIp` | `varchar(64)`, nullable | Client IP of the last stamped use, cut to 64 characters. |
| `PreviousToken` | `varchar(64)`, nullable, unique | SHA-256 hex digest of the secret the last rotation replaced, while its grace lasts. Hidden from `dehydrate()`. |
| `PreviousValidUntil` | `datetime`, nullable | The instant `PreviousToken` stops working. The previous secret counts only while this is set and later than `ctx.now`. |

Indexes: `access_token_hash_idx` (unique, `Token`), `access_token_uuid_idx` (unique, `Uuid`), `access_token_user_idx` (`user_id`), `access_token_expires_idx` (`ExpiresAt`), `access_token_previous_hash_idx` (unique, `PreviousToken`; any number of rows may leave it empty).

### Migrations

| Migration | `up` | `down` |
| --- | --- | --- |
| `RbacHttpTokenInitial_2026_08_11_01_00_00` | Creates the table with the columns above, except the two rotation columns, and the four first indexes. | Drops the table. |
| `AuthnTokenRotation_2026_10_21_00_00_00` | Adds `PreviousToken` and `PreviousValidUntil` and the unique index on `PreviousToken`. | Nothing. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Token model | ORM model `AccessToken`, registered by `@Model` on import | `AccessToken` | none | Not meant to be replaced; `DbTokenService` and `UsersTableTokenOwnerResolver` query it directly. |
| Migration | `@Migration('default')` class in the DI registry | the one above | none | Exported, so an app can reference it; it runs with the ORM's migration run. |

## Important behaviour

- **Hash only.** `Token` and `PreviousToken` hold 64-character hex digests; the plaintext is never written. A custom generator's `hash()` must fit the column; see [Token generation](07-token-generation.md).
- **Hidden columns.** `dehydrate()` leaves out `Id`, `Token`, `PreviousToken` and `user_id`, so a model serialised by mistake does not leak the hash or internal ids.
- **Deleting a user deletes their tokens** through the foreign key cascade. The table needs the `users` table to exist first.
- **`Kind` defaults to `pat`.** A model built without a valid kind gets `pat`; a row read from the database keeps its stored kind.
- **Rows without an expiry count as expired.** They are refused on use, and `deleteExpired` removes them.

## Best practices

- Run the ORM migrations before the first token request; the table does not exist until then.
- Query `rbac_access_tokens` through `TokenService`, not the model, from app code: the service keeps the hash, owner and kind rules.

## Examples

### Count live tokens per kind for a dashboard

```ts sample
import { AccessToken } from '@spinajs/authn-token';
import { DateTime } from 'luxon';

/** Live tokens (not revoked, not expired) grouped by kind, read through the model. */
export async function liveTokensByKind(now = DateTime.now()): Promise<Record<string, number>> {
  const rows = await AccessToken.where('ExpiresAt', '>', now).whereNull('RevokedAt');
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.Kind] = (counts[row.Kind] ?? 0) + 1;
  }
  return counts;
}
```

## Related

- [Issuing and revoking tokens](01-token-service.md): the only writer of the table.
- [CLI commands](06-cli-commands.md): `authn:token-delete-expired` removes expired, revoked and expiry-less rows.
- [`@spinajs/orm` migrations](../orm/10-migrations.md): how `@Migration` classes are found and run.
