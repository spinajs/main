# Session table and migrations

The store keeps every session in one table, `user_sessions`, mapped by the `DbSession` model on the connection named `session-provider-connection`. One migration creates the table through the schema builder.

## How it works

### Connection

1. `DbSession` carries `@Connection('session-provider-connection')` and `@Model('user_sessions')`.
2. When `Orm` resolves, it binds the model to the driver stored under `session-provider-connection`: a connection with that `Name`, or a `db.Aliases` entry that points the name at another connection.
3. The migration carries `@Migration('session-provider-connection')`. Importing the package registers it in DI, and the ORM's `DiRegistryMigrationSource` finds it; no directory scan is needed.
4. With `Migration.OnStartup: true` on the target connection, the ORM boot pass applies it when it is pending, in timestamp order with the other migrations of the same driver.

When no connection or alias has the name, `Orm` logs `Cannot find connection session-provider-connection` for the model and skips the migration with a warning. <!-- TODO(docs-hook): verify which error a DbSessionStore call raises when DbSession has no driver -->

### The migration

`UserSessionDBSqlMigration_2022_06_28_01_20_00` is the package's only migration. `up()`:

1. Creates `user_sessions` with the columns listed under [Schema](#user_sessions).
2. Creates the unique index `session_id_user_session_idx` on `SessionId`, and the indexes `user_sessions_subject_idx` on `Subject` and `user_sessions_impersonator_idx` on `ImpersonatorId`.

`down()` drops the table.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Connection('session-provider-connection')` | `DbSession` | connection name | Binds the model to that connection or alias. |
| `@Model('user_sessions')` | `DbSession` | table name | Maps the model to the table. |
| `@Primary()` | `DbSession.SessionId` | | Primary key; `destroy()` deletes by it. |
| `@CreatedAt()` | `DbSession.CreatedAt` | | Creation timestamp column. |
| `@DateTime()` | `DbSession.Expiration` | | Converts the column to a luxon `DateTime`. |
| `@Migration('session-provider-connection')` | `UserSessionDBSqlMigration_2022_06_28_01_20_00` | connection name | Registers the migration for that connection. |

`DbSession.Data` has **no** `@Json()` decorator: the store writes the string from `encodeSessionData()`, and `@Json()` would encode it a second time.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases['session-provider-connection']` | `string` | unset | a connection `Name` | Points the store's connection name at an existing connection. |
| `db.Connections[].Name` | `string` | | `session-provider-connection` | Alternative to the alias: a dedicated connection with this name. |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Applies the migration at boot. |

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
| `SessionId` | `VARCHAR(64)`, primary key, unique index `session_id_user_session_idx` | Storage key: `sha256(rawId)` as 64 hex characters. |
| `CreatedAt` | `NOT NULL`; the driver's datetime type: `DATETIME(3)` on MySQL, `TIMESTAMPTZ(3)` on PostgreSQL, `TEXT` on SQLite | Creation time. |
| `Expiration` | same type as `CreatedAt`, nullable | Absolute expiration; `NULL` means never. |
| `Data` | `NOT NULL`; `JSON` on MySQL, `JSONB` on PostgreSQL, no declared type on SQLite | Session data encoded by `encodeSessionData()`. |
| `Subject` | `VARCHAR(100)`, nullable, index `user_sessions_subject_idx` | Principal key of the owner. The store reads a row without one as absent. |
| `ImpersonatorId` | `VARCHAR(100)`, nullable, index `user_sessions_impersonator_idx` | Principal key of the impersonator; `NULL` when nobody impersonates. |
| `State` | `VARCHAR(16)`, nullable, no default | `active` or `pending`. Any other value reads as `pending`; `touch()` never updates a row with `NULL`. |

### `DbSession` model

| Property | Type | Column |
| --- | --- | --- |
| `SessionId` | `string` | `SessionId` |
| `CreatedAt` | `DateTime` | `CreatedAt` |
| `Expiration` | `DateTime` | `Expiration` (`null` when the column is `NULL`) |
| `Data` | `string` | `Data`. A MySQL `json` column reads back as a parsed object, SQLite as text. |
| `Subject` | `string \| null` | `Subject` |
| `ImpersonatorId` | `string \| null` | `ImpersonatorId` |
| `State` | `string \| null` | `State` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Session connection | ORM connection name `session-provider-connection` | none; you configure it | any connection, through `db.Aliases` | Alias it, or add a connection with that `Name`. See [Extending the session store](03-extending-the-session-store.md#connection-binding). |
| Session migration | `@Migration('session-provider-connection')`, registered in DI at import | `UserSessionDBSqlMigration_2022_06_28_01_20_00` | your own migrations on the same name | Add a migration with a later timestamp. See [Extending the session store](03-extending-the-session-store.md#extra-migrations). |

## Important behaviour

- `user_sessions` has no foreign key: a session names its owner by principal key in `Subject`, so the table does not depend on `users` and can live in another database. Deleting a user does not delete the user's sessions; call `SessionIssuer.revokeAll()` first.
- `State` has no default: a default of `active` would activate a row that never passed MFA.
- The migration creates the table and alters none: run it against a database without `user_sessions`.

## Best practices

- Bind `session-provider-connection` with `db.Aliases` to the application database unless sessions need a database of their own; one connection means one migration plan and one backup.
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

### Check that the session migration is applied before a deploy

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { UserSessionDBSqlMigration_2022_06_28_01_20_00 } from '@spinajs/session-provider-db';

export async function sessionSchemaIsCurrent(): Promise<boolean> {
  const orm = await DI.resolve(Orm);
  const connection = orm.Connections.get('session-provider-connection');
  if (!connection) {
    return false;
  }

  const applied = (await connection.select().from('spinajs_migration')) as Array<{ Migration: string }>;
  return applied.some((row) => row.Migration === UserSessionDBSqlMigration_2022_06_28_01_20_00.name);
}
```

## Related

- [Database session store](01-db-session-store.md): how the store reads and writes these columns.
- [Migrations](../orm/10-migrations.md): discovery, the boot pass, failed runs and `resolve()`.
- [Connections](../orm/01-connections.md): `db.Aliases`, `@Connection` and `Migration.OnStartup`.
