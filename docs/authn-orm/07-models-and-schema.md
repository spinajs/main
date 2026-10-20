# Models and schema

Every store of the package reads and writes through one of seven ORM models. Each model names its table and the `default` connection, so the stores take no driver. The package ships one migration on the same connection, which creates the tables.

## How it works

1. Importing `@spinajs/authn-orm` defines the seven models (`@Model`, `@Connection('default')`) and the migration `AuthnInitial_2026_10_02_00_00_00` (`@Migration('default')`).
2. `Orm.resolve()` binds each model to the driver stored under `default`, which `db.DefaultConnection` creates. With `Migration.OnStartup` on that connection, the boot pass runs the migration first.
3. A store method awaits `ormReady()` (from `@spinajs/orm`) before its first statement. It resolves the `Orm` from the root container when no one has yet, so a CLI command or a worker needs no explicit `DI.resolve(Orm)`.
4. Reads hydrate each `@DT()` column into a luxon `DateTime` through the ORM datetime converter. Writes pass `DateTime` values in UTC, computed in Node.

## Decorators

The models use these `@spinajs/orm` decorators:

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Connection('default')` | every model | connection name | The model runs on the `default` connection. |
| `@Model('<table>')` | every model | table name | Binds the model to its `authn_*` table. |
| `@Primary({ generated: 'assigned' })` | key properties | `generated: 'assigned'` | String keys the store assigns (a random UUID, a hash or a name); the database generates none. `AuthnMfa` has two, a composite key. |
| `@DT()` | datetime properties | | Hydrates the column as a luxon `DateTime`. A nullable datetime is declared optional (`used_at?: DateTime`), because `@DT()` rejects a `DateTime \| null` property. |
| `@Bool()` | `AuthnIdentity.email_verified` | | Hydrates the column as a `boolean`. |

## Models

| Model | Table | Primary key | Used by |
| --- | --- | --- | --- |
| `AuthnThrottle` | `authn_throttle` | `k` | [`DbThrottleStore`](01-throttle.md) |
| `AuthnSecret` | `authn_secret` | `id` | [`DbSecretStore`](02-secret-store.md) |
| `AuthnIdentity` | `authn_identity` | `id` | [`DbIdentityLinkStore`](03-identity-links.md) |
| `AuthnNonce` | `authn_nonce` | `k` | [`DbNonceStore`](04-nonce-store.md); `@spinajs/authn-keys` has its own `AuthnNonce` model on the same table |
| `AuthnMfa` | `authn_mfa` | `(identity, step)` | [`DbMfaStore`](05-mfa-store.md), and through it `DbMfaEnrolments` |
| `AuthnRecoveryCode` | `authn_recovery_code` | `id` | [`DbMfaStore`](05-mfa-store.md) |
| `AuthnAudit` | `authn_audit` | `id` | [`DbAuthnAuditSink`](06-audit-sink.md) |

The model `AuthnAudit` shares its name with the audit fan-out service of `@spinajs/authn`. Import the model from `@spinajs/authn-orm`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.DefaultConnection` | `string` | unset | a connection `Name` | Creates the `default` connection every model and the migration use. Required. |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Runs the migration in the boot pass when set on the default connection. |
| `db.StrictTableCheck` | `boolean` | `true` | `true`, `false` | Fails `Orm.resolve()` when one of the seven tables is missing. |

The `db.*` keys are owned by `@spinajs/orm`; see [Connections](../orm/01-connections.md#configuration).

```ts
db: {
  DefaultConnection: 'main',
  Connections: [{ Name: 'main', Driver: 'orm-driver-postgres', Migration: { OnStartup: true } }],
},
```

## Schema

Created by `AuthnInitial_2026_10_02_00_00_00`. None of the tables has a foreign key to `users`. The schema builder has no `char` type, so the 64-character hash columns are `varchar(64)`.

### `authn_throttle`

| Column | Type | Meaning |
| --- | --- | --- |
| `k` | `varchar(255)`, primary key; `string` | HMAC row id of a throttle key. |
| `attempts` | `int`; `number` | Counted attempts. |
| `last_attempt_at` | `datetime`; `DateTime` | Last counted attempt. |
| `next_allowed_at` | `datetime`; `DateTime` | The key delays every attempt before this time. |
| `updated_at` | `datetime`; `DateTime` | Last write. |

### `authn_secret`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key; `string` | Random UUID. |
| `identity` | `varchar(100)`; `string` | `<type>:<id>` of the owner. |
| `purpose` | `varchar(32)`; `string` | Purpose name. |
| `secret_hash` | `varchar(64)`, unique (`authn_secret_hash`); `string` | Hex SHA-256 of the raw secret. |
| `expires_at` | `datetime`; `DateTime` | End of validity. |
| `used_at` | `datetime`, nullable; `DateTime` (optional) | Time of the redeem. |
| `created_at` | `datetime`; `DateTime` | Time of the issue. |

Index `authn_secret_owner`: `(identity, purpose)`.

### `authn_identity`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key; `string` | Random UUID, the link id. |
| `identity_type` | `varchar(16)`; `string` | `IdentityRef.type`. |
| `identity_id` | `varchar(64)`; `string` | `IdentityRef.id`. |
| `provider` | `varchar(128)`; `string` | External provider. |
| `subject` | `varchar(255)`; `string` | Subject at the provider. |
| `email` | `varchar(255)`, nullable; `string \| null` | Email at link time. |
| `email_verified` | `boolean`, default `0`; `boolean` | Provider's verified flag. |
| `attributes` | `text`, nullable; `string \| null` | Not written by the store (`NULL`). |
| `linked_at` | `datetime`; `DateTime` | Time of the link. |
| `last_used_at` | `datetime`, nullable; `DateTime` (optional) | Set by `touch`. |

Unique index `authn_identity_subject`: `(provider, subject)`. Index `authn_identity_owner`: `(identity_type, identity_id)`.

### `authn_nonce`

| Column | Type | Meaning |
| --- | --- | --- |
| `k` | `varchar(160)`, primary key; `string` | The claimed value. |
| `expires_at` | `datetime`; `DateTime` | End of the claim. |

### `authn_mfa`

| Column | Type | Meaning |
| --- | --- | --- |
| `identity` | `varchar(100)`, primary key part; `string` | `<type>:<id>` of the owner. |
| `step` | `varchar(32)`, primary key part; `string` | Step name. |
| `secret_enc` | `text`; `string` | Cipher text, `v1.<iv>.<tag>.<ct>`. |
| `key_id` | `varchar(32)`; `string` | Id of the encrypting key. |
| `confirmed_at` | `datetime`, nullable; `DateTime` (optional) | Set by `confirm`. |
| `last_step` | `bigint`, nullable; `number \| string \| null` | Last accepted time step; PostgreSQL returns it as a string. |
| `created_at` | `datetime`; `DateTime` | Time of the last `put`. |

### `authn_recovery_code`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key; `string` | Random UUID. |
| `identity` | `varchar(100)`; `string` | `<type>:<id>` of the owner. |
| `code_hash` | `varchar(64)`; `string` | Hex SHA-256 of the raw code. |
| `used_at` | `datetime`, nullable; `DateTime` (optional) | Time of the redeem. |

Index `authn_recovery_code_owner`: `identity`.

### `authn_audit`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `varchar(36)`, primary key; `string` | Random UUID. |
| `at` | `datetime`; `DateTime` | Time of the event. |
| `type` | `varchar(32)`; `string` | Event type. |
| `outcome` | `varchar(8)`; `string` | `success` or `failure`. |
| `identity`, `actor` | `varchar(100)`, nullable; `string \| null` | `<type>:<id>` refs. |
| `strategy`, `reason`, `ip`, `session` | `varchar(64)`, nullable; `string \| null` | Event fields, cut to the column. |
| `user_agent` | `varchar(255)`, nullable; `string \| null` | Client user agent. |
| `data` | `text`, nullable; `string \| null` | JSON text. |

Indexes `authn_audit_at`: `at`; `authn_audit_identity`: `(identity, at)`.

## Migrations

| Migration | Connection | `up()` | `down()` |
| --- | --- | --- | --- |
| `AuthnInitial_2026_10_02_00_00_00` | `default` | Creates the seven tables and their indexes. | Drops the seven tables in reverse order. |

No migration of this package reads 2.x `users_metadata`. 2.x TOTP enrolments, pending password resets and invites are not carried over: users enrol again and request a new link.

`@spinajs/authn-keys` ships no migration for `authn_nonce`: its `DbKeyNonceStore` writes into the table this migration creates.

## Identity keys and time helpers

| Export | Meaning |
| --- | --- |
| `identityKey(ref, maxLength = 100)` | `<type>:<id>`, the value of every `identity` and `actor` column. A type that is empty or contains `:`, or a key longer than `maxLength`, throws `InvalidArgument`; it never truncates. |
| `parseIdentityKey(key)` | Splits at the first `:` into an `IdentityRef`; the id may contain more `:`. A key without a type throws `InvalidArgument`. |
| `readInstant(value)` | A `Date` from a `DateTime`, a `Date` or text (SQL format, else ISO-8601; text without an offset is UTC). `null` and `undefined` give `undefined`. |

## Important behaviour

- The stores never open a transaction, because the SQLite driver shares one handle. Each decision is one conditional statement; the pages of each store name the races that remain.
- A store call made inside your own `transaction()` on the `default` driver joins that transaction and rolls back with it, as every model statement does. See [`@spinajs/orm` Transactions](../orm/08-transactions.md).
- Time comes from Node: `ctx.now`, or `Date` at call time. Every claim, expiry and compare-and-set compares in SQL against a bound value; SQL `now()` is never used.
- Datetimes are written as UTC, as ISO-8601 text on SQLite. A `Date` outside the years 1000 to 9999 throws `InvalidArgument` before any statement, because SQLite compares those columns as text.
- With `db.StrictTableCheck` on (the default), importing the package makes all seven tables required on the `default` connection, whether the app uses every store or not.
- Secrets are never stored in clear: single-use secrets and recovery codes as SHA-256, MFA secrets as cipher text, throttle keys as an HMAC under `authn.audit.hashKey.secret`.

### Drivers and known gaps

- SQLite and PostgreSQL are tested against a real database. MySQL and MSSQL are checked only as compiled SQL.
- PostgreSQL: node-postgres reads `timestamp` as local time, so a value in the local spring DST gap reads back one hour late. No store decides on such a read.
- MySQL and MSSQL: `datetime` is coarser, so the throttle's undo may miss (more throttling) and a sub-second `baseDelayMs` is not supported.
- MySQL and MSSQL: the default collations ignore case. Every read checks identity, step, purpose, provider and subject exactly in Node, but writes keyed by identity follow the collation. Give the identity columns a binary collation on these drivers.

## Best practices

- Run the migration before the app serves traffic (`Migration.OnStartup`, or `migrate-up` in the deploy step), so the strict table check passes.
- Read the tables through the exported models after `await ormReady()`, not with raw SQL: the models hydrate datetimes the same way the stores write them.
- Build `identity` filters with `identityKey()`, so a query matches what the stores wrote.

## Patterns and antipatterns

```ts
// Don't: the models run on `default`; without it every store fails on its first statement
db: { Connections: [{ Name: 'main', Driver: 'orm-driver-postgres' }] }

// Do
db: { DefaultConnection: 'main', Connections: [{ Name: 'main', Driver: 'orm-driver-postgres' }] }
```

## Examples

### Count failed sign-ins of the last hour for a dashboard

```ts sample
import { AuthnAudit } from '@spinajs/authn-orm';
import { ormReady } from '@spinajs/orm';
import { DateTime } from 'luxon';

export async function failedSignInsLastHour(): Promise<number> {
  await ormReady();
  const since = DateTime.utc().minus({ hours: 1 });
  const rows = await AuthnAudit.query().columns(['id']).where('type', 'login').where('outcome', 'failure').where('at', '>=', since);
  return rows.length;
}
```

### List the users with a confirmed authenticator

```ts sample
import { AuthnMfa, parseIdentityKey } from '@spinajs/authn-orm';
import { ormReady } from '@spinajs/orm';

export async function usersWithTotp(): Promise<string[]> {
  await ormReady();
  const rows = await AuthnMfa.query().columns(['identity', 'step', 'confirmed_at']).where('step', 'totp').whereNotNull('confirmed_at');
  return rows.map((r) => parseIdentityKey(r.identity)).filter((ref) => ref.type === 'user').map((ref) => ref.id);
}
```

## Migration

### Stores take no driver and no `StoreOptions`

`DbAuthnAuditSink`, `DbIdentityLinkStore`, `DbSecretStore`, `DbNonceStore` and `DbMfaStore` have no constructor arguments. `DbAuthnThrottle` takes `(params?, options?)` and `DbThrottleStoreOptions` has no `driver`. The `StoreOptions` type is no longer exported. Every store uses the connection its model names, `default`, and resolves the `Orm` through `ormReady()` from the root container.

```ts
// Before: a driver, or the Orm of a given container
const audit = new DbAuthnAuditSink(driver);
const secrets = new DbSecretStore(undefined, { container: tenantContainer });

// After: point `default` at the database instead
db: { DefaultConnection: 'main' }
const audit = new DbAuthnAuditSink();
const secrets = new DbSecretStore();
```

An app that passed a driver of another connection moves the `authn_*` tables to the connection named by `db.DefaultConnection`. Datetime columns are hydrated by the ORM converter, so a subclass that read them as dialect-specific text reads luxon `DateTime` values.

## Related

- [`@spinajs/orm` Connections](../orm/01-connections.md): `db.DefaultConnection`, `db.StrictTableCheck` and `@Connection`.
- [`@spinajs/orm` Migrations](../orm/10-migrations.md): the boot pass and `Migration.OnStartup`.
- [`@spinajs/orm` Converters and hydration](../orm/04-converters-and-hydration.md): how `@DT()` columns become `DateTime` values.
- [Authentication internals: authn-orm tables](../authn-orm/07-models-and-schema.md): the tables in the login flow.
