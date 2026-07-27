# Configuration

## Options

| Option | Meaning |
| --- | --- |
| `Name` | Connection name — what `@Connection('...')` refers to. |
| `Driver` | `orm-driver-mssql`, matching the DI registration. |
| `Host`, `Port` | Server address. SQL Server's default port is 1433. |
| `User`, `Password` | Credentials. `Password` is never logged. |
| `Database` | Database name — the first part of the three-part table name. |
| `Pool.*` | `Min`, `Max`, `IdleTimeout`, `AcquireTimeout`. |
| `Resilience.*` | Health-check interval and retry policy. |
| `Migration.*` | `OnStartup`, `Table`, `Transaction.Mode`. |
| `Options` | Passed through to the `mssql` package, **plus** `Schema` (see below). |
| `AliasSeparator` | Defaults to **`#`** here, not `$`. |

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        DefaultConnection: 'mssql',
        Connections: [
          {
            Name: 'mssql',
            Driver: 'orm-driver-mssql',
            Host: '127.0.0.1',
            Port: 1433,
            User: 'sa',
            Password: 'Str0ng!Passw0rd',
            Database: 'app',
            Pool: { Min: 2, Max: 20, IdleTimeout: 30000, AcquireTimeout: 10000 },
            Resilience: { HealthCheckInterval: 30000, MaxRetries: 5 },
            Migration: {
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
            Options: {
              // Driver-specific: the schema used to qualify every table.
              Schema: 'dbo',
              // Passed straight to the `mssql` package.
              encrypt: true,
              trustServerCertificate: false,
              requestTimeout: 30000,
            },
          },
        ],
      },
    });
  }
}
```

## `Options.Schema`

`MsSqlTableAliasCompiler` builds a **three-part** name:

```sql
[database].[schema].[table] as [alias]
```

- `[database]` appears when the builder has one (from `Database`, or `database()` on the builder).
- `[schema]` appears when `Options.Schema` is set.
- The alias appears when the builder has one.

Set `Options.Schema: 'dbo'` unless your objects live elsewhere. Without it, tables resolve
against the connection's default schema, which is usually but not always what you want.

## `AliasSeparator`

The driver overrides the default in its constructor:

```ts
constructor(options: IDriverOptions) {
  super(Object.assign({ AliasSeparator: '#' }, options));
}
```

`$` is the framework-wide default, but it begins a pseudo-column in T-SQL, so generated aliases
would be invalid. Generated aliases here look like `#users#`.

Override it only if `#` collides with something in your schema.

## Backtick stripping

`executeOnDb` runs `stmt.replaceAll('`', '')` before sending anything to the server. The generic
SQL layer quotes identifiers with backticks — MySQL's convention — and T-SQL uses `[brackets]`,
so the backticks are removed wholesale rather than translated.

The practical consequence: **a backtick inside a string literal in a raw query will be stripped
too.** Bind values as parameters rather than interpolating them, which is what the builders do
anyway.

## Pooling

A real pool of read-write connections, backed by the `mssql` package's `ConnectionPool`.

| Option | Default |
| --- | --- |
| `Pool.Min` | `0` |
| `Pool.Max` | `10` |
| `Pool.IdleTimeout` | `30000` |
| `Pool.AcquireTimeout` | `10000` |

`PoolLimit` remains honoured when `Pool.Max` is absent.

## Transactions

Pooled, so `_begin` acquires a connection onto `ctx.connection` and `_dispose` releases it.
Statements inside the callback pick the transaction's request up from the context — only this
driver's `_begin` populates it, so nothing outside a transaction is affected.

All four isolation levels are declared:

```ts
public readonly SupportedIsolationLevels: IsolationLevel[] = [
  'READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE',
];
```

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function isolated() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['mssql'])!;

  return await driver.transaction(
    async () => driver.select().from('ledger').where('Posted', false),
    { isolation: 'SERIALIZABLE' },
  );
}
```

Nesting takes savepoints, so `save()` and nested `transaction()` calls compose.

Unlike MySQL, **SQL Server DDL *is* transactional** — `CREATE TABLE` and `ALTER TABLE` roll back
with the transaction. `Migration.Transaction.Mode = PerMigration` therefore gives a genuinely
atomic migration here.

## Encryption

The `mssql` package defaults to encrypted connections against Azure. For a local server with a
self-signed certificate:

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class LocalConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'mssql',
            Driver: 'orm-driver-mssql',
            Host: '127.0.0.1',
            Port: 1433,
            User: 'sa',
            Password: 'Str0ng!Passw0rd',
            Database: 'app',
            Options: {
              Schema: 'dbo',
              encrypt: false,
              trustServerCertificate: true,
            },
          },
        ],
      },
    });
  }
}
```

Do not carry `trustServerCertificate: true` into production — it disables certificate validation.

## Named instances

Reach a named instance through `Options.instanceName`, which the `mssql` package understands:

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class NamedInstanceConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      db: {
        Connections: [
          {
            Name: 'mssql',
            Driver: 'orm-driver-mssql',
            Host: 'db-server',
            User: 'app',
            Password: 'secret',
            Database: 'app',
            Options: {
              Schema: 'dbo',
              instanceName: 'SQLEXPRESS',
              // The SQL Browser service resolves the port; omit Port entirely.
            },
          },
        ],
      },
    });
  }
}
```

## Before you write

See the [README](README.md): this driver registers no `ServerResponseMapper`, so every insert
path throws. Selects, schema operations and transactions work.
