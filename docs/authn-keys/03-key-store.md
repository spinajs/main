# Key store

`KeyStore` is where `DefaultKeyRegistry` keeps key records. `OrmKeyStore` stores them in the `authn_key` table and is the default. `MemoryKeyStore` keeps them in one process, for tests and single-process tools.

## How it works

`DefaultKeyRegistry` calls the store; nothing else in the package does. Each method of `OrmKeyStore` goes through the `AuthnKey` model:

| Method | `OrmKeyStore` | Returns |
| --- | --- | --- |
| `insert(key)` | Reads by `kid` and by `thumbprint`; when neither exists, inserts a row. When the insert throws and a row with that `kid` or thumbprint now exists, another insert won a race. | `'inserted'` or `'duplicate'`; any other insert error is rethrown |
| `get(kid)` | Reads by `kid` and keeps only the row whose `kid` matches exactly, case included | `KeyRecord` or `null` |
| `listByOwner(owner)` | Reads by `owner_type` and `owner_id` | Every record of the owner, revoked and expired ones included |
| `revoke(owner, kid, at)` | Reads the key; when it exists, belongs to `owner` and is not revoked, sets `revoked_at` where `kid` matches and `revoked_at` is null | `'revoked'`, `'already'` or `'none'` |
| `touch(kid, at)` | Sets `last_used_at` | nothing |

A row becomes a frozen `KeyRecord`: `jwk` is parsed from JSON, `scope` from JSON with its `expiresAt` back to a `Date`, `created_by` from `<type>:<id>`, and every datetime to a `Date`.

`OrmKeyStore` injects `Orm`. The CLI resolves only the command it runs, so the `authn:key-*` commands extend `KeyCliCommand`, which injects the `Orm`: resolving a command boots the ORM, binds the `AuthnKey` model and applies the [`Migration.OnStartup` migrations](../orm/10-migrations.md), as an app process does.

`MemoryKeyStore` keeps the same contract in a `Map`. It stores frozen copies, so a caller cannot change a stored record.

## Schema

### `authn_key`

Created by `AuthnKeys_2026_10_02_00_00_00` on the `default` connection. Model: `AuthnKey`.

| Column | Type | Meaning |
| --- | --- | --- |
| `kid` | `varchar(64)`, primary key | Key id, 1-64 of `[A-Za-z0-9._-]`; default: the thumbprint |
| `owner_type` | `varchar(16)`, not null | `user`, `service` or `agent` |
| `owner_id` | `varchar(64)`, not null | The owner's id (`users.Uuid` for users) |
| `alg` | `varchar(16)`, not null | `EdDSA` or `ES256`, from the key type |
| `jwk` | `text`, not null | The public JWK as JSON, required members only |
| `thumbprint` | `varchar(64)`, not null, unique (`authn_key_thumb`) | RFC 7638 SHA-256 thumbprint, base64url |
| `scope` | `text` | The `Ceiling` as JSON, or null |
| `name` | `varchar(128)` | Label shown in `authn:key-list` and on `GET /user/keys` |
| `expires_at` | `datetime` | The key stops working at this instant |
| `revoked_at` | `datetime` | Set once by `revoke`; never cleared |
| `last_used_at` | `datetime` | Last successful verification, at most once a minute per process |
| `created_by` | `varchar(100)` | The actor that registered a service or agent key, as `<type>:<id>` |
| `created_at` | `datetime`, not null | Registration time |

Index `authn_key_owner` on (`owner_type`, `owner_id`) serves `listByOwner`. The `down` migration drops the table.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Key store | `KeyStore`, singleton; also registered as `OrmKeyStore` | `OrmKeyStore` | `MemoryKeyStore` (exported, not registered) | `DI.register(MemoryKeyStore).as(KeyStore)`, or subclass `OrmKeyStore` / `KeyStore` with `@Injectable(KeyStore)`. Register after `@spinajs/authn-keys` is imported and before the first resolve of `KeyRegistry` |

A custom `KeyStore` implements five methods. Keep these rules, `DefaultKeyRegistry` relies on them:

- `insert` returns `'duplicate'` when the `kid` **or** the thumbprint is taken, also when a parallel insert won.
- `get` matches the `kid` exactly, case included.
- `revoke` returns `'none'` when the key belongs to another owner type or id, and never moves an existing `revokedAt`.
- `listByOwner` includes revoked and expired keys.

### Key store: custom implementation

Subclass `OrmKeyStore` when the defaults fit and one method does not. This one skips the `last_used_at` write, for an app whose key table sits on a database it should not write on every request:

```ts sample
import { Injectable } from '@spinajs/di';
import { KeyStore, OrmKeyStore } from '@spinajs/authn-keys';

/** Keys live in the shared database; this app never writes last-use stamps there. */
@Injectable(KeyStore)
export class NoTouchKeyStore extends OrmKeyStore {
  public async touch(_kid: string, _at: Date): Promise<void> {
    // last_used_at stays as the other apps wrote it
  }
}
```

For tests, register the memory store instead:

```ts sample
import { DI } from '@spinajs/di';
import '@spinajs/authn-keys';
import { KeyStore, MemoryKeyStore } from '@spinajs/authn-keys';

DI.register(MemoryKeyStore).as(KeyStore);
```

## Important behaviour

- Datetimes are stored and read as UTC instants. The process time zone does not change a stored `expires_at` or `revoked_at`.
- `OrmKeyStore.revoke` is a conditional update (`revoked_at IS NULL`), so two parallel revocations keep the first time. When the driver reports no affected-row count, the call answers `'revoked'`.
- On a case-insensitive collation (the MySQL default), `get` still returns only the exact `kid`. `insert` treats a `kid` that differs only in case as taken.
- `MemoryKeyStore` loses every key when the process ends, and each process has its own. Never use it in an app with several instances.

## Best practices

- Run the migration with the rest of your ORM migrations (`Migration.OnStartup`, applied when the `Orm` resolves, or [`@spinajs/orm-cli`](../orm-cli/README.md)). The model and the migration use the `default` connection, which `db.DefaultConnection` provides.
- Keep `authn_key` on the same database for every app instance. A revocation must reach every verifier.

## Patterns and antipatterns

```ts
// Don't: cache byId results for minutes in a KeyStore; a revoked key keeps working until the entry expires
// Do: read through on every get; a key lookup is one primary-key read
```

## Examples

### Count usable keys per owner type for a dashboard

```ts sample
import { AuthnKey } from '@spinajs/authn-keys';

/** Usable service keys: not revoked and not expired. */
export async function usableServiceKeys(): Promise<number> {
  const now = Date.now();
  const rows = await AuthnKey.where({ owner_type: 'service' });
  return rows.filter((row) => !row.revoked_at && (!row.expires_at || row.expires_at.toMillis() > now)).length;
}
```

## Related

- [Key registry](02-key-registry.md): the only caller of the store.
- [`@spinajs/orm`](../orm/README.md): models, connections and migrations.
- [`@spinajs/authn-orm` models and schema](../authn-orm/07-models-and-schema.md): the other `authn_*` tables and driver notes.
