# Schema, views and events

`MySqlOrmDriver` registers the MySQL DDL compilers: column types, `ALTER TABLE`, `TRUNCATE`, table clones, history tables, views and scheduled events. The schema builder API is in [Schema builder](../orm/09-schema-builder.md); this page is what MySQL emits and what it cannot do.

## How it works

1. A migration or your code calls `driver.schema().createTable()`, `alterTable()`, `createView()`, `createEvent()`, `cloneTable()` or `truncate()`.
2. Awaiting the builder calls `toDB()`, which resolves the compiler for its token from the connection's container. `MySqlOrmDriver.resolve()` registered the MySQL set (table below).
3. A compiler returns one `ICompilerOutput` or an array. `SqlDriver.execute()` sends an array with `Promise.all`, one `executeOnDb()` per statement, with `QueryContext.Schema`.
4. `executeOnDb()` resolves the raw `mysql2` result. Errors surface as `OrmException` and are retried only on transport failure.

| Token | MySQL registers | Emits |
| --- | --- | --- |
| `ColumnQueryCompiler` | `SqlColumnQueryCompiler` | `` `name` TYPE [UNSIGNED] [CHARACTER SET '...'] [COLLATE '...'] [NOT NULL] [DEFAULT ...] [AUTO_INCREMENT] [COMMENT '...'] [UNIQUE] `` |
| `AlterTableQueryCompiler` | `SqlAlterTableQueryCompiler` | one `ALTER TABLE` per dropped column, rename and changed column |
| `AlterColumnQueryCompiler` | `SqlAlterColumnQueryCompiler` | `ADD <column> [AFTER x]`, `MODIFY <column>`, `RENAME COLUMN a TO b` |
| `LockTableQueryCompiler` | `MySqlLockTableQueryCompiler` | `SELECT COUNT(*) FROM <table> LOCK IN SHARE MODE` |
| `DefaultValueBuilder` | `SqlDefaultValueBuilder` | `date()`: `(CURRENT_DATE())`; `dateTime()`: `CURRENT_TIMESTAMP`; `value(v)`; `raw(q)` |
| `TruncateTableQueryCompiler` | `SqlTruncateTableQueryCompiler` | `TRUNCATE TABLE <table>` |
| `TableCloneQueryCompiler` | `SqlTableCloneQueryCompiler` | `CREATE [TEMPORARY] TABLE t LIKE src`, then for a deep clone `INSERT INTO t SELECT ...` |
| `TableHistoryQueryCompiler` | `SqlTableHistoryQueryCompiler` | `<table>__history` and triggers, for `table.trackHistory()` |
| `CreateViewCompiler` | `MySqlCreateViewCompiler` | `CREATE [OR REPLACE] [ALGORITHM=...] [SQL SECURITY ...] VIEW ... AS ... [WITH [CASCADED\|LOCAL] CHECK OPTION]` |
| `EventQueryCompiler`, `DropEventQueryCompiler` | `SqlEventQueryCompiler`, `SqlDropEventQueryCompiler` | `CREATE EVENT ... ON SCHEDULE ...`, `DROP EVENT [IF EXISTS]` |
| `LimitQueryCompiler`, `RecursiveQueryCompiler` | `SqlLimitQueryCompiler`, `SqlWithRecursiveCompiler` | `LIMIT ? [OFFSET ?]` (an offset alone writes `LIMIT 18446744073709551615 OFFSET ?`), `WITH RECURSIVE` |

### Column types

| Schema builder type | MySQL |
| --- | --- |
| `string(name, n?)` | `VARCHAR(n)`, default `255` |
| `text`, `tinytext`, `mediumtext`, `longtext` | the same names |
| `int`, `tinyint`, `smallint`, `mediumint`, `bigint`, `bit` | the same names |
| `float`, `double`, `decimal` (`precision?`, `scale?`) | `TYPE(precision,scale)`, defaults `8,2` |
| `boolean` | `BOOLEAN` (stored as `TINYINT(1)`) |
| `date`, `dateTime`, `time`, `timestamp` | the same names |
| `enum(name, values)` | `ENUM('a','b')` |
| `set(name, values)` | `SET('a','b')` |
| `json` | `JSON` |
| `binary(name, n?)` | `BINARY(n)`, default `255` |
| `uuid(name)` | `BINARY(16)`, written by `UuidConverter` |
| `tinyblob`, `mediumblob`, `longblob` | the same names |

### Views

`MySqlCreateViewCompiler` extends `SqlCreateViewQueryCompiler` with `Engine = 'mysql'` and overrides three hooks:

- `_replace()`: `OR REPLACE` after `orReplace()`.
- `_prefixOptions()`: `ALGORITHM=<value>` and `SQL SECURITY <value>` from `algorithm()` and `security()`.
- `_checkOption()`: `checkOptionSql()`, so `checkOption()`, `checkOption('CASCADED')` and `checkOption('LOCAL')` all work.

`ifNotExists()` and `temporary()` throw `MethodNotImplemented('mysql does not support IF NOT EXISTS')` and `('... TEMPORARY')`. Bindings in the view body are written into the SQL by `MySqlLiteralQuoter`. See [View compiler hooks](../orm-sql/06-view-compiler-hooks.md).

### Events

`supportedFeatures().events` is `true`. `createEvent('cleanup', e => e.every(3, 'MINUTE').comment("it's a cleanup").do(raw))` compiles to:

```sql
CREATE EVENT `cleanup`
ON SCHEDULE EVERY 3 MINUTE
ON COMPLETION NOT PRESERVE
ENABLE
COMMENT 'it\'s a cleanup'
DO DELETE FROM ...
```

The server runs events only when `event_scheduler` is `ON`; creating one needs the `EVENT` privilege.

### DDL is not transactional

MySQL commits implicitly before and after `CREATE`, `ALTER`, `DROP`, `TRUNCATE` and `RENAME`. Consequences:

- `Migration.Transaction.Mode = PerMigration` or `PerRun` opens a transaction, but a migration that fails after its third `CREATE TABLE` leaves all three applied.
- A data change made before DDL in the same transaction is committed by that DDL.
- `down()` may run against a half-applied `up()`.

### Migrations

- The tracking table defaults to `spinajs_migration` and is created with `createTableIfAbsent`, scoped to the connection's own database (`table_schema = DATABASE()`).
- Inside a transaction every statement runs on the transaction's connection, in order. Outside one, the statements of a multi-statement compile run on separate pooled connections at the same time.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Connections[].Migration.OnStartup` | `boolean` | unset (off) | | Run pending migrations of this connection at boot. |
| `db.Connections[].Migration.Table` | `string` | `spinajs_migration` | | Tracking table. |
| `db.Connections[].Migration.Transaction.Mode` | `MigrationTransactionMode` | `None` | `None`, `PerMigration`, `PerRun` | Wraps migrations in a transaction; DDL still commits implicitly. |

Server settings this page depends on: `event_scheduler = ON` for events; MySQL 8.0 or MariaDB 10.5.2 for `RENAME COLUMN`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| View compiler | `CreateViewCompiler`; `@NewInstance() @Inject(Container)`, constructor `(container, builder)` | `MySqlCreateViewCompiler` (not exported) | | Extend `SqlCreateViewQueryCompiler` from `@spinajs/orm-sql`, override the hooks, register `.as(CreateViewCompiler)` after `super.resolve()`. |
| Column compiler | `ColumnQueryCompiler`; constructor `(builder: ColumnQueryBuilder)` | `SqlColumnQueryCompiler` | | Extend `SqlColumnQueryCompiler`, override `compile()`; register `.as(ColumnQueryCompiler)`. `SqlTableQueryCompiler` resolves it once per column. |
| Alter compilers | `AlterTableQueryCompiler`, `AlterColumnQueryCompiler` | `SqlAlterTableQueryCompiler`, `SqlAlterColumnQueryCompiler` | | Extend; `SqlAlterColumnQueryCompiler` has one hook per alteration type. See [Query compilers](../orm-sql/02-query-compilers.md). |
| Default values | `DefaultValueBuilder` | `SqlDefaultValueBuilder` | | Extend and override `date()` / `dateTime()`; register `.as(DefaultValueBuilder)`. |
| Clone, truncate, history | `TableCloneQueryCompiler`, `TruncateTableQueryCompiler`, `TableHistoryQueryCompiler` | `SqlTableCloneQueryCompiler`, `SqlTruncateTableQueryCompiler`, `SqlTableHistoryQueryCompiler` | | Extend the `Sql*` class, register under its token. |
| Event compilers | `EventQueryCompiler`, `DropEventQueryCompiler` | `SqlEventQueryCompiler`, `SqlDropEventQueryCompiler` | `Unsupported*` classes on the other drivers | Extend, register under its token. |

### View compiler: custom implementation

MySQL defaults a view to `SQL SECURITY DEFINER`: it runs with its creator's privileges. This compiler makes `INVOKER` the default, so a reporting user reads only what its own grants allow, unless a migration asks for `security('DEFINER')`.

```ts sample
import { Container, Inject, Injectable, NewInstance } from '@spinajs/di';
import { CreateViewCompiler, CreateViewQueryBuilder } from '@spinajs/orm';
import { SqlCreateViewQueryCompiler } from '@spinajs/orm-sql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

@NewInstance()
@Inject(Container)
export class InvokerByDefaultViewCompiler extends SqlCreateViewQueryCompiler {
  protected Engine = 'mysql';

  constructor(container: Container, builder: CreateViewQueryBuilder) {
    super(container, builder);
  }

  protected _replace(): string {
    return this.builder.Replace ? 'OR REPLACE' : '';
  }

  protected _prefixOptions(): string {
    const options: string[] = [];

    if (this.builder.Algorithm) {
      options.push(`ALGORITHM=${this.builder.Algorithm}`);
    }

    options.push(`SQL SECURITY ${this.builder.Security ?? 'INVOKER'}`);

    return options.join(' ');
  }

  protected _checkOption(): string {
    return this.checkOptionSql();
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class InvokerViewsMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(InvokerByDefaultViewCompiler).as(CreateViewCompiler);
  }
}
```

## Important behaviour

- A multi-statement compile (`alterTable()` with several changes, `cloneTable()` with `deepClone()`, `trackHistory()`) is sent with `Promise.all`. Outside a transaction each statement takes its own pooled connection, so they run concurrently and in no fixed order: a deep clone's `INSERT ... SELECT` can reach the server before its `CREATE TABLE ... LIKE`.
- `trackHistory()` emits `DELIMITER $$`, a `mysql` command-line directive the server does not accept, and its trigger matches rows on a column named `Id`.
- `TRUNCATE TABLE` resets the auto-increment counter and cannot be rolled back.
- `onDelete` / `onUpdate` foreign keys need InnoDB tables; MyISAM accepts the syntax and ignores the constraint.
- A view body has no placeholders: its bindings are inlined by `MySqlLiteralQuoter`, which escapes backslashes (`'it\'s'`).
- `algorithm()`, `security()` and `checkOption()` reject values outside their lists, because those values reach the SQL unquoted.

## Best practices

- Keep one DDL change per migration step, so a partial failure is easy to reason about.
- Write `down()` with `ifExists()` on every drop, since it may run after a half-applied `up()`.
- Await DDL statements one at a time, or run them inside `driver.transaction()`, when their order matters.
- Guard event migrations with `supportedFeatures().events`, so the same migration runs on SQLite in tests.

## Patterns and antipatterns

```ts
// Don't: one alterTable() with a rename and a new column; the two ALTER statements race
await connection.schema().alterTable('invoices', (t) => {
  t.rename('invoice');
  t.int('DueDays').addColumn();
});

// Do: await each change
await connection.schema().alterTable('invoices', (t) => t.int('DueDays').addColumn());
await connection.schema().alterTable('invoices', (t) => t.rename('invoice'));
```

## Examples

### Create the orders table and a paid-orders view

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('shop')
export class ShopOrders_2026_10_17_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('orders', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.int('CustomerId').notNull();
      t.decimal('Total', 10, 2).notNull();
      t.boolean('Paid').notNull().default().value(0);
      t.dateTime('CreatedAt').notNull().default().dateTime();
    });

    await connection.schema().createView('paid_orders', (v) => {
      v.orReplace()
        .algorithm('MERGE')
        .security('INVOKER')
        .as((q) => q.from('orders').where('Paid', 1));
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropView('paid_orders').ifExists();
    await connection.schema().dropTable('orders').ifExists();
  }
}
```

### Purge expired password-reset tokens every hour

```ts sample
import { Migration, OrmDriver, OrmMigration, RawQuery } from '@spinajs/orm';

@Migration('shop')
export class PurgeResetTokens_2026_10_17_10_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().createEvent('purge_reset_tokens', (event) => {
      event
        .every(1, 'HOUR')
        .comment('Delete password-reset tokens older than a day')
        .do(new RawQuery('DELETE FROM password_resets WHERE CreatedAt < NOW() - INTERVAL 1 DAY'));
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().dropEvent('purge_reset_tokens').ifExists();
  }
}
```

## Related

- [Schema builder](../orm/09-schema-builder.md): the builder API and the dialect support table.
- [Migrations](../orm/10-migrations.md): `@Migration`, transaction modes, the tracking table.
- [View compiler hooks](../orm-sql/06-view-compiler-hooks.md): every hook `SqlCreateViewQueryCompiler` offers.
- [Query compilers](../orm-sql/02-query-compilers.md): the shared `Sql*` compilers MySQL registers.
- [Set membership and literal quoting](07-set-membership-and-literals.md): how view and event bodies are quoted.
