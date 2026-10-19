# Schema and DDL

The schema builder (`driver.schema()`, migrations) compiles through SQLite's own column, table, alter-column, truncate, view and table-exists compilers. They map the ORM's column types onto SQLite's storage classes, move composite keys to a table constraint, keep `ADD COLUMN` legal on populated tables, and refuse what SQLite cannot do instead of sending MySQL DDL.

## How it works

1. `driver.schema().createTable(name, cb)` builds a `TableQueryBuilder`. Its `toDB()` resolves `TableQueryCompiler` from the driver container: `SqliteTableQueryCompiler`.
2. `SqliteTableQueryCompiler.compile()`:
   1. With more than one primary-key column, it throws `OrmException('sqlite cannot auto-increment column <col>: it is part of the composite primary key of <table>')` if one of them is auto-increment, otherwise it clears `InlinePrimaryKey` on each.
   2. Renders `CREATE [TEMPORARY] TABLE [IF NOT EXISTS] <table>` (inherited `_table()`).
   3. Renders each column with `ColumnQueryCompiler`: `SqliteColumnCompiler`.
   4. Appends `PRIMARY KEY (...)` for a composite key and the foreign keys from `ForeignKeyQueryCompiler`.
   5. Returns one statement. `trackHistory()` is ignored.
3. `driver.schema().alterTable(name, cb)` compiles with the shared `SqlAlterTableQueryCompiler`, which resolves `AlterColumnQueryCompiler` per column: `SqliteAlterColumnQueryCompiler`. See [`ALTER TABLE` limitations](#alter-table-limitations).
4. Every statement runs as `QueryContext.Schema` on the writer handle.

### Type mapping

`SqliteColumnCompiler` maps `ColumnType` to a declared SQLite type. Length, precision and scale arguments are dropped.

| ORM type (`table.<method>()`) | SQLite |
| --- | --- |
| `binary`, `tinyblob`, `mediumblob`, `longblob`, `uuid` (binary 16) | `BLOB` |
| `string`, `text`, `tinytext`, `mediumtext`, `longtext` | `TEXT` |
| `date`, `dateTime`, `time`, `timestamp` | `TEXT` |
| `enum`, `set` | `TEXT` |
| `float`, `double` | `REAL` |
| `decimal` | `DECIMAL` |
| `int`, `tinyint`, `smallint`, `mediumint`, `bigint` | `INTEGER` |
| `boolean` | `BOOLEAN NOT NULL CHECK ( col IN (0, 1))` in `CREATE TABLE`, `BOOLEAN CHECK ( col IN (0, 1))` in `ADD COLUMN` |
| `json`, `bit` | no declared type (the column name alone) |

- Datetimes are stored as ISO-8601 text; the datetime value converter does the round trip.
- `enum` and `set` values are not constrained by the database. The set converter joins and splits on commas.
- A column with no declared type gets no type affinity, and `tableInfo()` reports an empty `NativeType` for it.

### Column modifiers

Emitted in this order, each only when set: `UNSIGNED`, `CHARACTER SET '<x>'`, `COLLATE '<x>'`, `NOT NULL`, `DEFAULT ...`, `COMMENT '<x>'`, `PRIMARY KEY` (single-column key only), `AUTOINCREMENT`, `UNIQUE`.

SQLite rejects `CHARACTER SET` in any position, and `COMMENT` after any constraint (`NOT NULL`, `DEFAULT`). Do not call `charset()` or `comment()` on SQLite columns.

### Default values

`column.default()` resolves `DefaultValueBuilder` from the driver container: `SqlLiteDefaultValueBuilder`.

| Call | Emits |
| --- | --- |
| `.default().value('draft')` | `DEFAULT 'draft'` (trimmed, not escaped) |
| `.default().value(0)` | `DEFAULT 0` |
| `.default().date()` | `DEFAULT ((strftime('%Y-%m-%d', 'now')))` |
| `.default().dateTime()` | `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`: UTC ISO-8601 with milliseconds |
| `.default().raw(RawQuery.create('...'))` | `DEFAULT (...)`; the raw query's bindings are ignored |

`.default()` returns the `DefaultValueBuilder`, and its methods return the base `ColumnQueryBuilder`: chain `default()` last.

### Composite primary keys

SQLite rejects two inline `PRIMARY KEY` constraints, so a key of several columns becomes a table constraint, ``PRIMARY KEY (`a`,`b`)``. `AUTOINCREMENT` is legal only on a single `INTEGER PRIMARY KEY`, so an auto-increment column in a composite key throws at compile time. Use `@Primary({ generated: 'uuid' })` or `'assigned'` there.

### `ALTER TABLE` limitations

| Alteration | Emits | Notes |
| --- | --- | --- |
| `table.<type>(name)` / `.addColumn()` | `ALTER TABLE t ADD <body>` | Body from `SqliteAddColumnCompiler`. No `AFTER`; `.after(col)` is ignored. |
| `.modify()` | nothing | Logs a `warn` on the `ORM` logger: `sqlite cannot MODIFY column <col> - skipping ...`. Type, `NOT NULL`, `DEFAULT` and `UNIQUE` changes are **not** applied. |
| `.rename(newName)` | ``ALTER TABLE t RENAME COLUMN `old` TO `new` `` | |
| `table.dropColumn(name)` | ``ALTER TABLE t DROP COLUMN `name` `` | |
| `table.rename(newTable)` | ``ALTER TABLE t RENAME TO `new` `` | |

- `ADD COLUMN` of a boolean drops the unconditional `NOT NULL` and keeps the `CHECK`. SQLite refuses to add a `NOT NULL` column without a non-null default to a table with rows; `.notNull().default().value(0)` still gives a non-nullable column.
- `PRIMARY KEY` and `UNIQUE` are **not** stripped from `ADD COLUMN`: SQLite's own error (`Cannot add a PRIMARY KEY column`, `Cannot add a UNIQUE column`) surfaces. Recreate the table, or add a unique index with `driver.index()`.
- A `.modify()` has no effect, so portable migrations that restate a column definition keep working. A constraint change needs a table-rebuild migration.

### Other DDL

| Builder | Token | SQLite implementation | Result |
| --- | --- | --- | --- |
| `driver.truncate(t)`, `Model.truncate()` | `TruncateTableQueryCompiler` | `SqliteTruncateTableQueryCompiler` | `DELETE FROM t`; the `AUTOINCREMENT` counter is **not** reset |
| `schema().tableExists(t, schema?)` | `TableExistsCompiler` | `SqliteTableExistsCompiler` | `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`; `schema` is ignored |
| `schema().lockTable(t)` | `LockTableQueryCompiler` | `SqliteLockTableQueryCompiler` | no statement; see [Locking a table](../orm/09-schema-builder.md#locking-a-table) |
| `schema().createView(v, cb)` | `CreateViewCompiler` | `SqliteCreateViewCompiler` | `CREATE [TEMP] VIEW [IF NOT EXISTS] ...`; `orReplace()`, `algorithm()`, `security()`, `checkOption()` throw `MethodNotImplemented` |
| `schema().createDatabase(d)` | `CreateDatabaseCompiler` | `SqliteCreateDatabaseQueryCompiler` | throws `NotSupported('sqlite does not support CREATE DATABASE, ...')` |
| `schema().dropDatabase(d)` | `DropDatabaseCompiler` | `SqliteDropDatabaseQueryCompiler` | throws `NotSupported('sqlite does not support DROP DATABASE, delete the database file instead')` |
| `schema().createEvent()`, `dropEvent()` | `EventQueryCompiler`, `DropEventQueryCompiler` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` | throw `MethodNotImplemented('orm-driver-sqlite has no native scheduled events')` |
| `schema().cloneTable()` | `TableCloneQueryCompiler` | not registered | fails to resolve: SQLite has no `CREATE TABLE ... LIKE` |
| `createTable(...).trackHistory()` | `TableHistoryQueryCompiler` | not registered, never called | no history table is created |
| `driver.index()` | `IndexQueryCompiler` | shared `SqlIndexQueryCompiler` | `CREATE [UNIQUE] INDEX ...` |

## Configuration

No keys of its own. Migrations that run this DDL are configured under `db.Connections[].Migration`; see [Migrations](../orm/10-migrations.md).

## Schema

The driver creates no tables. It reads SQLite's catalogue: `sqlite_master` for `tableExists()`, and `PRAGMA table_info`, `index_list`, `index_info`, `foreign_key_list` for `tableInfo()` (see [Connection and driver](01-connection.md#table-reflection)).

## Services and extension points

All registered by `SqliteOrmDriver.resolve()` in the connection's child container, new instance per resolve.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Column body | `ColumnQueryCompiler`, new instance | `SqliteColumnCompiler` (exported) | `SqlColumnQueryCompiler` (MySQL spelling) | Subclass `SqliteColumnCompiler`; override `compile()`, `_booleanDefinition()` or `_defaultCompiler()`. |
| `ADD COLUMN` body | `SqliteAddColumnCompiler` (class token), new instance; resolved by `SqliteAlterColumnQueryCompiler._columnDefinition()` | `SqliteAddColumnCompiler` (exported) | | Register a subclass `.as(SqliteAddColumnCompiler)`. |
| Column alteration | `AlterColumnQueryCompiler`, new instance | `SqliteAlterColumnQueryCompiler` (exported) | `SqlAlterColumnQueryCompiler` | Subclass; override `_add()`, `_modify()`, `_rename()`, `_columnDefinition()`; return `null` to emit nothing. |
| Table alteration | `AlterTableQueryCompiler`, new instance | `SqlAlterTableQueryCompiler` from `@spinajs/orm-sql` | | Subclass `SqlAlterTableQueryCompiler`. |
| `CREATE TABLE` | `TableQueryCompiler`, new instance | `SqliteTableQueryCompiler` (exported) | `SqlTableQueryCompiler` | Subclass; override `compile()`, `_columns()`, `_foreignKeys()`, `_primaryKeys()`, `_table()`. |
| Column default | `DefaultValueBuilder`, new instance | `SqlLiteDefaultValueBuilder` (**not exported**) | `SqlDefaultValueBuilder` from `@spinajs/orm-sql` (MySQL functions) | Extend `DefaultValueBuilder` from `@spinajs/orm`, implement `date()`, `dateTime()`, `value()`, `raw()`. |
| Truncate | `TruncateTableQueryCompiler`, new instance | `SqliteTruncateTableQueryCompiler` (exported) | `SqlTruncateTableQueryCompiler` (`TRUNCATE TABLE`) | Subclass; constructor is `(container, builder)`. |
| Table exists | `TableExistsCompiler`, new instance | `SqliteTableExistsCompiler` (exported) | | Subclass; override `compile()`. |
| Views | `CreateViewCompiler`, new instance | `SqliteCreateViewCompiler` (exported) | | Override the clause hooks; see [View compiler hooks](../orm-sql/06-view-compiler-hooks.md). |
| Create / drop database | `CreateDatabaseCompiler`, `DropDatabaseCompiler` | `SqliteCreateDatabaseQueryCompiler`, `SqliteDropDatabaseQueryCompiler` (exported, both throw) | | Register a compiler that emits `ATTACH` / `DETACH` if that is what your app means. |
| Events | `EventQueryCompiler`, `DropEventQueryCompiler` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` from `@spinajs/orm-sql` | | Leave as is; SQLite has no scheduler. |

Register every replacement in a driver subclass's `resolve()`, after `super.resolve()`. See [Extending the driver](07-extending-the-driver.md).

### Column body: custom implementation

Give `json` columns a type and a validity check, in both `CREATE TABLE` and `ADD COLUMN`. The `ADD COLUMN` path resolves `SqliteAddColumnCompiler` by class, so register a subclass of it too.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ColumnQueryCompiler, ICompilerOutput } from '@spinajs/orm';
import { SqliteAddColumnCompiler, SqliteColumnCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

function withJsonType(output: ICompilerOutput, type: string, name: string): ICompilerOutput {
  if (type !== 'json') {
    return output;
  }

  const quoted = `\`${name}\``;
  return { ...output, expression: (output.expression ?? '').replace(quoted, `${quoted} TEXT CHECK (json_valid(${quoted}))`) };
}

@NewInstance()
export class JsonColumnCompiler extends SqliteColumnCompiler {
  public compile(): ICompilerOutput {
    return withJsonType(super.compile(), this.builder.Type, this.builder.Name);
  }
}

@NewInstance()
export class JsonAddColumnCompiler extends SqliteAddColumnCompiler {
  public compile(): ICompilerOutput {
    return withJsonType(super.compile(), this.builder.Type, this.builder.Name);
  }
}

@Injectable('orm-driver-sqlite-json')
@NewInstance()
export class JsonSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(JsonColumnCompiler).as(ColumnQueryCompiler);
    this.Container.register(JsonAddColumnCompiler).as(SqliteAddColumnCompiler);
  }
}
```

`table.json('Settings')` now emits `` `Settings` TEXT CHECK (json_valid(`Settings`)) ``.

### Column default: custom implementation

Store creation times as Unix seconds instead of ISO text. `SqlLiteDefaultValueBuilder` is not exported, so extend the abstract `DefaultValueBuilder`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DefaultValueBuilder, RawQuery } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class EpochDefaultValueBuilder<T> extends DefaultValueBuilder<T> {
  constructor(protected Owner: T) {
    super();
  }

  public date(): T {
    this.Query = RawQuery.create("date('now')");
    return this.Owner;
  }

  public dateTime(): T {
    // the column compiler wraps it: DEFAULT (unixepoch('now'))
    this.Query = RawQuery.create("unixepoch('now')");
    return this.Owner;
  }

  public value(val: string | number): T {
    this.Value = val;
    return this.Owner;
  }

  public raw(query: RawQuery): T {
    this.Query = query;
    return this.Owner;
  }
}

@Injectable('orm-driver-sqlite-epoch')
@NewInstance()
export class EpochSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(EpochDefaultValueBuilder).as(DefaultValueBuilder);
  }
}
```

### Column alteration: custom implementation

Fail a migration that tries to `modify()` a column, instead of skipping it with a warning.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AlterColumnQueryCompiler } from '@spinajs/orm';
import { SqliteAlterColumnQueryCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class StrictAlterColumnCompiler extends SqliteAlterColumnQueryCompiler {
  protected _modify(_definition: string): string | null {
    throw new InvalidOperation(`sqlite cannot MODIFY column ${this.builder.Name}; write a table-rebuild migration`);
  }
}

@Injectable('orm-driver-sqlite-strict-ddl')
@NewInstance()
export class StrictDdlSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(StrictAlterColumnCompiler).as(AlterColumnQueryCompiler);
  }
}
```

### `CREATE TABLE`: custom implementation

Refuse `trackHistory()` loudly rather than create a table without history.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { ICompilerOutput, TableQueryCompiler } from '@spinajs/orm';
import { SqliteOrmDriver, SqliteTableQueryCompiler } from '@spinajs/orm-sqlite';

@NewInstance()
export class NoHistoryTableCompiler extends SqliteTableQueryCompiler {
  public compile(): ICompilerOutput[] {
    if (this.builder.TrackHistory) {
      throw new NotSupported(`table ${this.builder.Table}: sqlite driver does not create history tables`);
    }

    return super.compile();
  }
}

@Injectable('orm-driver-sqlite-no-history')
@NewInstance()
export class NoHistorySqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(NoHistoryTableCompiler).as(TableQueryCompiler);
  }
}
```

### Table exists: custom implementation

Make `tableExists(name, schema)` look inside an attached database.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, TableExistsCompiler } from '@spinajs/orm';
import { escapeIdentifier } from '@spinajs/orm-sql';
import { SqliteOrmDriver, SqliteTableExistsCompiler } from '@spinajs/orm-sqlite';

@NewInstance()
export class AttachedTableExistsCompiler extends SqliteTableExistsCompiler {
  public compile(): ICompilerOutput {
    const catalogue = this.builder.Database ? `${escapeIdentifier(this.builder.Database)}.sqlite_master` : 'sqlite_master';

    return {
      bindings: [this.builder.Table],
      expression: `SELECT name FROM ${catalogue} WHERE type='table' AND name=? LIMIT 1;`,
    };
  }
}

@Injectable('orm-driver-sqlite-attached')
@NewInstance()
export class AttachedSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(AttachedTableExistsCompiler).as(TableExistsCompiler);
  }
}
```

The `ATTACH` must be on the handle that runs the check: inside a transaction, or with `Pool.Max: 1`; see [Read handle pool](02-read-pool.md).

## Important behaviour

- Foreign keys are compiled but **not enforced**: SQLite checks them only with `PRAGMA foreign_keys = ON`, per connection, and the driver never sends it. `ON DELETE CASCADE` does nothing until you enable it (see [Examples](#enforce-foreign-keys-on-every-connection)).
- `CHARACTER SET` and `COMMENT` produce invalid SQLite DDL.
- `value()` defaults are not escaped: `value("it's")` emits `DEFAULT 'it's'`, a syntax error.
- `json` and `bit` columns get no declared type.
- `truncate()` keeps the `AUTOINCREMENT` counter; new rows continue after the highest key ever used.
- `trackHistory()` and `cloneTable()` have no SQLite implementation.
- `.modify()` and `.after()` are silent no-ops apart from the `modify` warning.
- An `alterTable()` with several alterations compiles to several statements, sent with `Promise.all`. Do not make one depend on another inside the same callback; use two `alterTable()` calls.

## Best practices

- Declare booleans with `.notNull().default().value(0)` so they can be added to populated tables.
- Use `@Primary({ generated: 'uuid' })` or `'assigned'` for composite keys.
- Write SQLite-specific table rebuilds behind `@Migration('<connection>')` when a column constraint has to change.
- Guard scheduled-event migrations with `driver.supportedFeatures().events`.
- Reset the counter after a truncate when tests depend on key values: `DELETE FROM sqlite_sequence WHERE name = ?`.

## Patterns and antipatterns

```ts
// Don't: sqlite cannot add a NOT NULL boolean to a populated table without a default
table.boolean('IsArchived').notNull();

// Do
table.boolean('IsArchived').notNull().default().value(0);
```

```ts
// Don't: CHARACTER SET and COMMENT are MySQL-only and break CREATE TABLE on SQLite
table.string('Title').charset('utf8mb4').comment('headline');

// Do
table.string('Title').notNull();
```

## Examples

### Add a flag to a populated table

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('main')
export class ArticlesAddIsPublished_2026_07_27_20_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('articles', (table) => {
      // default() is chained last: its methods return the base ColumnQueryBuilder
      table.boolean('IsPublished').notNull().default().value(0);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('articles', (table) => {
      table.dropColumn('IsPublished');
    });
  }
}
```

### Create a table with a composite key and timestamps

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('main')
export class CreateOrderLines_2026_08_01_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('order_lines', (table) => {
      table.int('OrderId').notNull().primaryKey();
      table.int('LineNo').notNull().primaryKey();
      table.string('Sku').notNull();
      table.int('Qty').notNull().default().value(1);
      table.dateTime('CreatedAt').notNull().default().dateTime();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('order_lines');
  }
}
```

The key becomes ``PRIMARY KEY (`OrderId`,`LineNo`)`` at table level.

### Enforce foreign keys on every connection

`PRAGMA foreign_keys` is per handle. Read handles never write, so the writer is enough.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrmDriver, QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-fk')
@NewInstance()
export class ForeignKeySqliteDriver extends SqliteOrmDriver {
  public async connect(): Promise<OrmDriver> {
    await super.connect();
    await this.executeOnDb('PRAGMA foreign_keys = ON', [], QueryContext.Schema);
    return this;
  }
}
```

## Related

- [Schema builder](../orm/09-schema-builder.md): the builder API these compilers implement.
- [Migrations](../orm/10-migrations.md): where DDL usually runs.
- [Query compilers](../orm-sql/02-query-compilers.md): the shared compilers and their tokens.
- [View compiler hooks](../orm-sql/06-view-compiler-hooks.md): `SqliteCreateViewCompiler`'s hooks in context.
- [Value converters and default values](../orm-sql/05-value-converters-and-defaults.md): `DefaultValueBuilder` across dialects.
