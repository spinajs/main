# Session table and migrations

The store keeps every session in one table, `user_sessions`, mapped by the `DbSession` model on the connection named `session-provider-connection`. Four migrations create the table and bring older databases to the current shape; they run on MySQL / MariaDB, PostgreSQL and SQLite.

## How it works

### Connection

1. `DbSession` carries `@Connection('session-provider-connection')` and `@Model('user_sessions')`.
2. When `Orm` resolves, it binds the model to the driver stored under `session-provider-connection`: a connection with that `Name`, or a `db.Aliases` entry that points the name at another connection.
3. The four migrations carry `@Migration('session-provider-connection')`. Importing the package registers them in DI, and the ORM's `DiRegistryMigrationSource` finds them; no directory scan is needed.
4. With `Migration.OnStartup: true` on the target connection, the ORM boot pass applies the pending ones in timestamp order, together with the other migrations of the same driver (for example `@spinajs/users`).

When no connection or alias has the name, `Orm` logs `Cannot find connection session-provider-connection` for the model and skips the migrations with a warning. <!-- TODO(docs-hook): verify which error a DbSessionStore call raises when DbSession has no driver -->

### Migrations, in order

| Migration | Dialects | What it does |
| --- | --- | --- |
| `UserSessionDBSqlMigration_2022_06_28_01_20_00` | all | Creates `user_sessions` when it does not exist, with a unique index `session_id_user_session_idx` on `SessionId`. Returns early when the table exists. `down()` does nothing. |
| `UserSessionDataJson_2026_07_31_00_00_00` | MySQL | Converts a text-family `Data` column (`text`, `tinytext`, `mediumtext`, `longtext`, `varchar`, `nvarchar`) to `JSON NOT NULL`. **Deletes every session first.** `down()` turns a `json` column back into `TEXT NOT NULL`. |
| `UserSessionTimestamps_2026_07_31_00_00_01` | MySQL | Widens `CreatedAt` and `Expiration` from `date` to `DATETIME` when `CreatedAt` is `date`. `down()` does nothing. |
| `UserSessionIdHash_2026_10_02_00_00_00` | MySQL, PostgreSQL, SQLite | Adds `Subject`, `ImpersonatorId` and `State`, widens `SessionId` to 64 characters, makes `UserId` nullable, indexes `Subject` and `ImpersonatorId`, and backfills the new columns of existing rows. `down()` drops the three columns. |

### `UserSessionDataJson_2026_07_31_00_00_00`, step by step

1. Returns when `user_sessions` does not exist.
2. Reads the native type of `Data` from `connection.tableInfo()`. Returns when it cannot be read (the driver throws, the column is missing) or when it is not text-family, for example already `json`.
3. Returns when `connection.Options.Driver` is not `orm-driver-mysql` or `orm-driver-mysql-ssh`.
4. Runs `DELETE FROM user_sessions`. MySQL validates every row during a `text` to `json` conversion, and one malformed payload would fail it.
5. Runs one `ALTER TABLE user_sessions MODIFY Data JSON NOT NULL`.

### `UserSessionIdHash_2026_10_02_00_00_00`, step by step

1. Returns when `user_sessions` does not exist.
2. Adds each missing column, one `ALTER TABLE` per column: `Subject` `VARCHAR(100)`, `ImpersonatorId` `VARCHAR(100)`, `State` `VARCHAR(16)`. `State` has no default.
3. When `UserId` is `NOT NULL`:
   - SQLite: rebuilds the table as `user_sessions_v3` with `SessionId` `VARCHAR(64)` and a nullable `UserId`, copies the rows, drops the old table, renames the new one and recreates `session_id_user_session_idx`.
   - MySQL: one statement, `MODIFY SessionId VARCHAR(64) NOT NULL, MODIFY UserId INT NULL`.
   - PostgreSQL (`orm-driver-postgres`): two `ALTER COLUMN` statements.
   - Any other driver name: nothing.
4. Creates `user_sessions_subject_idx` and `user_sessions_impersonator_idx` for the columns it added (both after a SQLite rebuild).
5. Backfills every row with `Subject IS NULL`: decodes `Data` and writes `Subject`, `ImpersonatorId` and `State` the way `adaptLegacySession()` reads them. Undecodable rows and rows without a `User` entry are skipped.

Existing rows keep their raw 2.x keys. `DefaultSessionIssuer` re-saves each under `sha256(rawId)` on its first use.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Connection('session-provider-connection')` | `DbSession` | connection name | Binds the model to that connection or alias. |
| `@Model('user_sessions')` | `DbSession` | table name | Maps the model to the table. |
| `@Primary()` | `DbSession.SessionId` | | Primary key; `destroy()` deletes by it. |
| `@CreatedAt()` | `DbSession.CreatedAt` | | Creation timestamp column. |
| `@DateTime()` | `DbSession.Expiration` | | Converts the column to a luxon `DateTime`. |
| `@Migration('session-provider-connection')` | each migration class | connection name | Registers the migration for that connection. |

`DbSession.Data` has **no** `@Json()` decorator: the store writes the string from `encodeSessionData()`, and `@Json()` would encode it a second time.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases['session-provider-connection']` | `string` | unset | a connection `Name` | Points the store's connection name at an existing connection. |
| `db.Connections[].Name` | `string` | | `session-provider-connection` | Alternative to the alias: a dedicated connection with this name. |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Applies the four migrations at boot. |

```ts
this.Config = _.merge(this.Config, {
  db: {
    DefaultConnection: 'main',
    Aliases: { 'session-provider-connection': 'main' },
    Connections: [{ Name: 'main', Driver: 'orm-driver-postgres', Host: 'db', Database: 'shop', Migration: { OnStartup: true } }],
  },
});
```

## Schema

### `user_sessions`

| Column | Type | Meaning |
| --- | --- | --- |
| `SessionId` | `VARCHAR(64)`, primary key, unique index `session_id_user_session_idx` | Storage key: `sha256(rawId)` as 64 hex characters, or the raw 2.x uuid until the issuer re-keys the row. |
| `CreatedAt` | `NOT NULL`; `DATETIME` on MySQL, `TIMESTAMP` on PostgreSQL, text on SQLite | Creation time. |
| `Expiration` | same type as `CreatedAt`, nullable | Absolute expiration; `NULL` means never. |
| `Data` | `NOT NULL`; `JSON` on MySQL, `JSONB` on PostgreSQL, no declared type on SQLite, text on old databases the JSON migration did not convert | Session data encoded by `encodeSessionData()`. |
| `UserId` | `INT`, nullable, FK to `users.Id` `ON DELETE CASCADE` | 2.x owner. Always `NULL` on rows the 3.0 store writes. |
| `Subject` | `VARCHAR(100)`, index `user_sessions_subject_idx` | Principal key of the owner; `NULL` on a row written by 2.x. |
| `ImpersonatorId` | `VARCHAR(100)`, index `user_sessions_impersonator_idx` | Principal key of the impersonator. |
| `State` | `VARCHAR(16)`, no default | `active` or `pending`; `NULL` on a row written by 2.x. |

### `DbSession` model

| Property | Type | Column |
| --- | --- | --- |
| `SessionId` | `string` | `SessionId` |
| `CreatedAt` | `DateTime` | `CreatedAt` |
| `Expiration` | `DateTime` | `Expiration` (`null` when the column is `NULL`) |
| `Data` | `string` | `Data`. A MySQL `json` column reads back as a parsed object, SQLite as text. |
| `UserId` | `number \| null` | `UserId` |
| `Subject` | `string \| null` | `Subject` |
| `ImpersonatorId` | `string \| null` | `ImpersonatorId` |
| `State` | `string \| null` | `State` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session connection | ORM connection name `session-provider-connection` | none; you configure it | any connection, through `db.Aliases` | Alias it, or add a connection with that `Name`. See [Extending the session store](03-extending-the-session-store.md#connection-binding). |
| Session migrations | `@Migration('session-provider-connection')`, registered in DI at import | the four classes above | your own migrations on the same name | Add a migration with a later timestamp. See [Extending the session store](03-extending-the-session-store.md#extra-migrations). |

## Important behaviour

- **MSSQL is not supported.** `orm-mssql` registers no `AlterTableQueryCompiler`, so the column adds of `UserSessionIdHash_2026_10_02_00_00_00` throw. The migration is recorded as failed, and the ORM then refuses every later migration on that connection.
- Dialects are recognised by `db.Connections[].Driver`, by exact name. A driver registered under another name, even a subclass of the MySQL driver, gets no `SessionId` widening and keeps `UserId` `NOT NULL`, so every `save()` of a 64-character key or a `NULL` `UserId` fails.
- On a fresh database the table is created with `SessionId` `VARCHAR(36)` and `UserId` `NOT NULL`; `UserSessionIdHash_2026_10_02_00_00_00` then reshapes it in the same boot pass.
- The create migration needs the `users` table on the same connection for its foreign key. Its timestamp is later than `@spinajs/users`'s `RBACInitial_2022_06_28_01_13_00`, so on one connection the parent table exists first.
- `UserSessionDataJson_2026_07_31_00_00_00` logs every user out once on the MySQL deployments it converts. A database already on `json`, and every other dialect, loses nothing.
- Every guard that cannot read the current column type skips the migration instead of failing it, so a boot never stops on a conversion nobody needs.
- `UserSessionIdHash_2026_10_02_00_00_00.down()` drops `Subject`, `ImpersonatorId` and `State`; it does **not** narrow `SessionId` or make `UserId` `NOT NULL` again. `UserSessionTimestamps_2026_07_31_00_00_01.down()` deliberately does nothing: narrowing to `date` would drop the time of day.
- `UserSessionDBSqlMigration_2022_06_28_01_20_00` returns early on an existing table, so the type it declares for `Data` never reaches an old database; the JSON migration does that on MySQL.

## Best practices

- Run the session migrations on the connection that holds `users`, through `db.Aliases`, so they run in one ordered plan with the `@spinajs/users` migrations.
- Upgrade 2.x instances in a rolling deploy without a session purge: rows 2.x instances still write keep `Subject` `NULL`, and the store adapts them on every read.
- Query `user_sessions` through the store, not through `DbSession`: `Data` comes back as a string on one driver and as an object on another.

## Patterns and antipatterns

```ts
// Don't: Data is already JSON text; @Json() stringifies it a second time.
@Json()
public Data: string;

// Do: leave Data undecorated and decode with decodeSessionData() from @spinajs/authn-session.
public Data: string;
```

## Examples

### Report sessions still written by 2.x instances during a rolling upgrade

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { DbSession } from '@spinajs/session-provider-db';

export async function legacySessionCount(): Promise<number> {
  await DI.resolve(Orm);
  const rows = await DbSession.where('Subject', null);
  return rows.length;
}
```

### Check that the session migrations are applied before a deploy

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { UserSessionIdHash_2026_10_02_00_00_00 } from '@spinajs/session-provider-db';

export async function sessionSchemaIsCurrent(): Promise<boolean> {
  const orm = await DI.resolve(Orm);
  const connection = orm.Connections.get('session-provider-connection');
  if (!connection) {
    return false;
  }

  const applied = (await connection.select().from('spinajs_migration')) as Array<{ Migration: string }>;
  return applied.some((row) => row.Migration === UserSessionIdHash_2026_10_02_00_00_00.name);
}
```

## Related

- [Database session store](01-db-session-store.md): how the store reads and writes these columns.
- [Migrations](../orm/10-migrations.md): discovery, the boot pass, failed runs and `resolve()`.
- [Connections](../orm/01-connections.md): `db.Aliases`, `@Connection` and `Migration.OnStartup`.
- [`@spinajs/users`](../users/README.md): the `users` table referenced by `UserId`.
