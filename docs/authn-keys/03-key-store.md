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

A row becomes a frozen `KeyRecord`: `jwk` is parsed from JSON, `scope` from JSON with its `expiresAt` back to a `Date`, `created_by` from `<type>:<id>`, and every datetime to a `Date`. An `expires_at` or `revoked_at` that holds no readable datetime becomes an invalid `Date`, so the key is not usable: see [Unreadable `expires_at` or `revoked_at`](#unreadable-expires_at-or-revoked_at).

`OrmKeyStore` injects `Orm`. The CLI resolves only the command it runs; an `authn:key-*` command injects `KeyRegistry`, which injects the `KeyStore`, so resolving the command boots the ORM and binds the `AuthnKey` model. A `KeyStore` of your own that queries models injects the `Orm` too. The boot fails while a migration is pending or failed, so run [`npx spinajs migrate-up`](../orm/10-migrations.md#deploying-migrations) first.

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
| `expires_at` | `datetime` | The key stops working at this instant; `NULL` means never |
| `revoked_at` | `datetime` | Set once by `revoke`; never cleared; `NULL` means not revoked |
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
- `get` and `listByOwner` never leave out an `expiresAt` or `revokedAt` the row holds but the store cannot read: give it as an invalid `Date` (`new Date(NaN)`), which `isUsableKey` reads as expired and revoked. A missing member means never expires or not revoked. A subclass of `OrmKeyStore` that overrides `get` or `listByOwner` takes this on itself.

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

### Unreadable `expires_at` or `revoked_at`

An `expires_at` or `revoked_at` that holds a value no datetime converter reads (text written by hand on SQLite, a MySQL zero date, a PostgreSQL `infinity` or `-infinity`, a PostgreSQL date after the year 275760) makes the key unusable: it reads as expired and revoked, and `OrmKeyStore` logs a warning naming the kid on each read of the row. Only SQL `NULL` means no expiry or not revoked, so a key written by hand with PostgreSQL `infinity` for "never expires" stops working: set it to `NULL`. `authn:key-list` prints such an instant as `unreadable`; the owner's key listing (`GET /user/keys`) gives it as `null` and marks the key `revoked` or `expired`. `authn:key-revoke` on such a key prints `Key <kid> revoked` but leaves the stored value as it is and writes no `key.revoke` audit event, because the store answers `already`; the repair statement below leaves a readable revocation. The store never writes such a value; MSSQL's `DATETIMEOFFSET` cannot hold one. To find these keys on the `default` connection:

```sql
-- PostgreSQL
SELECT kid FROM authn_key WHERE NOT isfinite(expires_at) OR expires_at > '275760-09-13 00:00:00+00'
  OR NOT isfinite(revoked_at) OR revoked_at > '275760-09-13 00:00:00+00';
-- MySQL
SELECT kid FROM authn_key WHERE CAST(expires_at AS CHAR) LIKE '____-00-%' OR CAST(expires_at AS CHAR) LIKE '____-__-00%'
  OR CAST(revoked_at AS CHAR) LIKE '____-00-%' OR CAST(revoked_at AS CHAR) LIKE '____-__-00%';
-- SQLite: the condition for expires_at; OR it with the same one for revoked_at
SELECT kid FROM authn_key WHERE expires_at IS NOT NULL
  AND NOT (typeof(expires_at) IN ('integer', 'real') AND abs(expires_at) <= 8640000000000)
  AND NOT (julianday(expires_at) IS NOT NULL AND date(substr(expires_at, 1, 10), '+0 days') = substr(expires_at, 1, 10))
  AND NOT (ltrim(expires_at, '-') GLOB '[0-9]*' AND ltrim(expires_at, '-') NOT GLOB '*[^0-9.]*' AND expires_at NOT GLOB '*.*.*' AND abs(CAST(expires_at AS REAL)) <= 8640000000000);
```

Repair a revocation with a real instant, the same statement on every driver: `UPDATE authn_key SET revoked_at = CURRENT_TIMESTAMP WHERE kid = '<kid>'`. Setting `revoked_at` to `NULL` makes the key usable again. Repair an expiry with a real instant, or with `NULL` only for a key that should never expire.

## Best practices

- Apply the migration with the rest of your ORM migrations: [`npx spinajs migrate-up`](../orm/10-migrations.md#deploying-migrations) in the deploy step (the app and the CLI commands refuse to boot until it is applied). The model and the migration use the `default` connection, which `db.DefaultConnection` provides.
- Keep `authn_key` on the same database for every app instance. A revocation must reach every verifier.

## Patterns and antipatterns

```ts
// Don't: cache byId results for minutes in a KeyStore; a revoked key keeps working until the entry expires
// Do: read through on every get; a key lookup is one primary-key read
```

## Examples

### Count the usable keys of a service for a dashboard

Read through the store, not the `AuthnKey` model: a row read straight from the model has no `expires_at` or `revoked_at` when the column holds no readable datetime, which looks like a key that never expires and is not revoked.

```ts sample
import { DI } from '@spinajs/di';
import { KeyStore, isUsableKey } from '@spinajs/authn-keys';

/** Usable keys of one service: not revoked and not expired. */
export async function usableServiceKeys(serviceId: string): Promise<number> {
  const now = new Date();
  const keys = await DI.resolve(KeyStore).listByOwner({ type: 'service', id: serviceId });
  return keys.filter((key) => isUsableKey(key, now)).length;
}
```

## Related

- [Key registry](02-key-registry.md): the only caller of the store.
- [`@spinajs/orm`](../orm/README.md): models, connections and migrations.
- [`@spinajs/authn-orm` models and schema](../authn-orm/07-models-and-schema.md): the other `authn_*` tables and driver notes.
