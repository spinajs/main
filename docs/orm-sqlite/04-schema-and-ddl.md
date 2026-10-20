# Schema and DDL

The schema builder (`driver.schema()`, migrations) compiles through SQLite's own column, table, alter-column, truncate, view and table-exists compilers. They map the ORM's column types onto SQLite's storage classes, move composite keys to a table constraint, keep `ADD COLUMN` legal on populated tables, and refuse what SQLite cannot do instead of sending MySQL DDL.

## How it works

1. `driver.schema().createTable(name, cb)` builds a `TableQueryBuilder`. Its `toDB()` resolves `TableQueryCompiler` from the driver container: `SqliteTableQueryCompiler`.
2. `SqliteTableQueryCompiler.compile()`:
   1. Throws `NotSupported('sqlite driver does not support history tables, ...')` when `trackHistory()` was called: the shared history compiler emits MySQL triggers.
   2. With more than one primary-key column, it throws `OrmException('sqlite cannot auto-increment column <col>: it is part of the composite primary key of <table>')` if one of them is auto-increment, otherwise it clears `InlinePrimaryKey` on each.
   3. Renders `CREATE [TEMPORARY] TABLE [IF NOT EXISTS] <table>` (inherited `_table()`).
   4. Renders each column with `ColumnQueryCompiler`: `SqliteColumnCompiler`.
   5. Appends `PRIMARY KEY (...)` for a composite key and the foreign keys from `ForeignKeyQueryCompiler`.
   6. Returns one statement.
3. `driver.schema().alterTable(name, cb)` compiles with the shared `SqlAlterTableQueryCompiler`, which resolves `AlterColumnQueryCompiler` per column: `SqliteAlterColumnQueryCompiler`. An `alterTable()` that modifies columns does not compile: `SqliteOrmDriver.execute()` rebuilds the table instead. See [`ALTER TABLE` limitations](#alter-table-limitations).
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

- `dateTime()` and `timestamp()` are SQLite's instant type: fixed-width ISO-8601 UTC text in a `TEXT` column. See [Value conversion](#value-conversion).
- `enum` and `set` values are not constrained by the database. The set converter joins and splits on commas.
- A column with no declared type gets no type affinity, and `tableInfo()` reports an empty `NativeType` for it.

### Value conversion

The driver container resolves these converters for model columns, `where()` values and raw bindings:

| Token | SQLite implementation | Writes | Reads |
| --- | --- | --- | --- |
| `DatetimeValueConverter` | `IsoDatetimeValueConverter` from `@spinajs/orm-sql` | `2026-10-19T12:00:00.123Z`: UTC, milliseconds, `Z` <!-- TODO(docs-hook): verify whether a datetime property on an INTEGER column is written as Unix seconds; SqlDatetimeValueConverter matches lower-case type names and PRAGMA table_info reports upper case --> | any ISO or SQL text, `Date`, `DateTime` or Unix seconds, as a `DateTime` in UTC |
| `BooleanValueConverter` | `SqlBooleanValueConverter` (shared) | `1` / `0` | `true` for `1`, `1n`, `true` and `'1'` |
| `SetValueConverter` | `SqlSetConverter` (shared) | comma-joined text | split on `,` |

- The fixed width keeps text order equal to time order, so `orderBy('CreatedAt')` and `where('CreatedAt', '>', date)` compare instants correctly, whatever the process time zone.
- `Date` and `DateTime` bindings of raw SQL (`executeOnDb()`, `RawQuery` bindings) are converted the same way by `SqlDriver.toDriverParams()`.
- `toJSON()` writes datetimes as ISO 8601 in UTC and booleans as `true` / `false`.
- Text written by hand in another format (`2026-10-19 12:00:00`) still reads back, but compares as text against the stored ISO form. Write instants through the converter or `driver.now()`.

The converters themselves are described in [Value converters and default values](../orm-sql/05-value-converters-and-defaults.md).

### Column modifiers

Emitted in this order, each only when set: `UNSIGNED`, `COLLATE '<x>'`, `NOT NULL`, `DEFAULT ...`, `PRIMARY KEY` (single-column key only), `AUTOINCREMENT`, `UNIQUE`.

`exact()` emits nothing: a SQLite column compares with `BINARY` unless it declares another collation.

`charset()` and `comment()` emit nothing: SQLite has no column character sets and no column comments, so portable migrations that call them still run.

### Default values

`column.default()` resolves `DefaultValueBuilder` from the driver container: `SqlLiteDefaultValueBuilder`.

| Call | Emits |
| --- | --- |
| `.default().value('draft')` | `DEFAULT 'draft'` (trimmed, `'` doubled: `value("it's")` gives `DEFAULT 'it''s'`) |
| `.default().value(0)` | `DEFAULT 0` |
| `.default().date()` | `DEFAULT ((strftime('%Y-%m-%d', 'now')))`: the UTC date |
| `.default().dateTime()` | `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`: UTC ISO-8601 with milliseconds, the same text the datetime converter writes and `driver.now()` returns |
| `.default().raw(RawQuery.create('...'))` | `DEFAULT (...)`; the raw query's bindings are ignored |

`.default()` returns the `DefaultValueBuilder`, and its methods return the base `ColumnQueryBuilder`: chain `default()` last.

### Composite primary keys

SQLite rejects two inline `PRIMARY KEY` constraints, so a key of several columns becomes a table constraint, ``PRIMARY KEY (`a`,`b`)``. `AUTOINCREMENT` is legal only on a single `INTEGER PRIMARY KEY`, so an auto-increment column in a composite key throws at compile time. Use `@Primary({ generated: 'uuid' })` or `'assigned'` there.

### `ALTER TABLE` limitations

| Alteration | Emits | Notes |
| --- | --- | --- |
| `table.<type>(name)` / `.addColumn()` | `ALTER TABLE t ADD <body>` | Body from `SqliteAddColumnCompiler`. No `AFTER`; `.after(col)` is ignored. |
| `.modify()` | a table rebuild | See [Modifying columns](#modifying-columns). |
| `.rename(newName)` | ``ALTER TABLE t RENAME COLUMN `old` TO `new` `` | |
| `table.dropColumn(name)` | ``ALTER TABLE t DROP COLUMN `name` `` | SQLite refuses to drop an indexed column: drop the index first with `driver.index().name(i).table(t).drop()`. |
| `table.rename(newTable)` | ``ALTER TABLE t RENAME TO `new` `` | |

- `ADD COLUMN` of a boolean drops the unconditional `NOT NULL` and keeps the `CHECK`. SQLite refuses to add a `NOT NULL` column without a non-null default to a table with rows; `.notNull().default().value(0)` still gives a non-nullable column.
- `PRIMARY KEY` and `UNIQUE` are **not** stripped from `ADD COLUMN`: SQLite's own error (`Cannot add a PRIMARY KEY column`, `Cannot add a UNIQUE column`) surfaces. Recreate the table, or add a unique index with `driver.index()`.

### Modifying columns

SQLite has no `ALTER COLUMN`. `SqliteOrmDriver.execute()` runs an `alterTable()` whose columns are all `.modify()` as a table rebuild, the [procedure SQLite documents](https://sqlite.org/lang_altertable.html#otheralter):

1. `modifyByRebuild(builder)` refuses with `NotSupported` when the same `alterTable()` also adds, renames or drops a column, or renames the table. Put those in an `alterTable()` of their own.
2. It opens `driver.transaction()` (a savepoint inside yours) and reads the table's `CREATE TABLE` from `sqlite_master`. A missing table throws `OrmException`.
3. With `PRAGMA foreign_keys` on, it throws `NotSupported` when another table has a foreign key to this one: dropping the table would delete or reject the referencing rows.
4. Each modified column's definition is replaced by the compiled `ColumnQueryCompiler` body plus the clauses of the old definition the builder does not restate: `PRIMARY KEY` unless `primaryKey()`, `UNIQUE` unless `unique()`, `COLLATE` unless `collation()`, `CHECK` unless the new body has one, and every `REFERENCES`. A column the table lacks throws `OrmException`; a generated column throws `NotSupported`.
5. It creates `<table>__rebuild` with the new definitions and the old table constraints, copies every row with `INSERT INTO ... SELECT`, drops the old table, renames the new one, and re-creates the table's indexes and triggers from their stored SQL.

Type, nullability and default come from the builder alone, as with MySQL's `MODIFY`: restate `notNull()` and `default()` or they are dropped. Compiled on its own (`builder.toDB()`), a modify throws `NotSupported`, because no single statement expresses the rebuild.

### Other DDL

| Builder | Token | SQLite implementation | Result |
| --- | --- | --- | --- |
| `driver.truncate(t)`, `Model.truncate()` | `TruncateTableQueryCompiler` | `SqliteTruncateTableQueryCompiler` | `DELETE FROM t`; the `AUTOINCREMENT` counter is **not** reset |
| `schema().tableExists(t, schema?)` | `TableExistsCompiler` | `SqliteTableExistsCompiler` | `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`; `schema` is ignored |
| `driver.lockTableShared(t)` | none, a driver method | `SqliteOrmDriver.lockTableShared()` | `DELETE FROM t WHERE 0` inside the transaction: takes the database's `RESERVED` lock; see [Shared table lock](../orm/08-transactions.md#shared-table-lock) |
| `schema().createView(v, cb)` | `CreateViewCompiler` | `SqliteCreateViewCompiler` | `CREATE [TEMP] VIEW [IF NOT EXISTS] ...`; `orReplace()`, `algorithm()`, `security()`, `checkOption()` throw `MethodNotImplemented` |
| `schema().createDatabase(d)` | `CreateDatabaseCompiler` | `SqliteCreateDatabaseQueryCompiler` | throws `NotSupported('sqlite does not support CREATE DATABASE, ...')` |
| `schema().dropDatabase(d)` | `DropDatabaseCompiler` | `SqliteDropDatabaseQueryCompiler` | throws `NotSupported('sqlite does not support DROP DATABASE, delete the database file instead')` |
| `schema().createEvent()`, `dropEvent()` | `EventQueryCompiler`, `DropEventQueryCompiler` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` | throw `MethodNotImplemented('orm-driver-sqlite has no native scheduled events')` |
| `schema().cloneTable()` | `TableCloneQueryCompiler` | not registered | fails to resolve: SQLite has no `CREATE TABLE ... LIKE` |
| `createTable(...).trackHistory()` | `TableQueryCompiler` | `SqliteTableQueryCompiler` | throws `NotSupported('sqlite driver does not support history tables, ...')` |
| `driver.index()` | `IndexQueryCompiler` | `SqliteIndexQueryCompiler` | `CREATE [UNIQUE] INDEX ...`; after `drop()`, `` DROP INDEX `name` `` with no table, as index names are schema-wide |

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
| Column alteration | `AlterColumnQueryCompiler`, new instance | `SqliteAlterColumnQueryCompiler` (exported) | `SqlAlterColumnQueryCompiler` | Subclass; override `_add()`, `_rename()`, `_columnDefinition()`; return `null` to emit nothing. `_modify()` throws `NotSupported` and is reached only by compiling a modify on its own. |
| Column modify | `SqliteOrmDriver.execute()`, protected `modifyByRebuild(builder)` | table rebuild | | Override `modifyByRebuild()` in a driver subclass. |
| Index | `IndexQueryCompiler`, new instance | `SqliteIndexQueryCompiler` (exported) | `SqlIndexQueryCompiler` (`DROP INDEX ... ON t`) | Subclass; override `compile()` or `_drop()`. |
| Table alteration | `AlterTableQueryCompiler`, new instance | `SqlAlterTableQueryCompiler` from `@spinajs/orm-sql` | | Subclass `SqlAlterTableQueryCompiler`. |
| `CREATE TABLE` | `TableQueryCompiler`, new instance | `SqliteTableQueryCompiler` (exported) | `SqlTableQueryCompiler` | Subclass; override `compile()`, `_columns()`, `_foreignKeys()`, `_primaryKeys()`, `_table()`. |
| Column default | `DefaultValueBuilder`, new instance | `SqlLiteDefaultValueBuilder` (exported) | `SqlDefaultValueBuilder` from `@spinajs/orm-sql` (MySQL functions) | Subclass `SqlLiteDefaultValueBuilder`, or extend `DefaultValueBuilder` from `@spinajs/orm` and implement `date()`, `dateTime()`, `value()`, `raw()`. |
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

Store creation times as Unix seconds instead of ISO text. Every method changes, so this extends the abstract `DefaultValueBuilder` rather than `SqlLiteDefaultValueBuilder`.

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

Fail a migration that places a new column with `.after()`, instead of appending it silently.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { AlterColumnQueryCompiler } from '@spinajs/orm';
import { SqliteAlterColumnQueryCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class StrictAlterColumnCompiler extends SqliteAlterColumnQueryCompiler {
  protected _add(definition: string): string | null {
    if (this.builder.AfterColumn) {
      throw new NotSupported(`sqlite cannot place column ${this.builder.Name} after ${this.builder.AfterColumn}`);
    }

    return super._add(definition);
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

Refuse to create a table without a primary key, so every model row can be addressed.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ICompilerOutput, TableQueryCompiler } from '@spinajs/orm';
import { SqliteOrmDriver, SqliteTableQueryCompiler } from '@spinajs/orm-sqlite';

@NewInstance()
export class KeyedTableCompiler extends SqliteTableQueryCompiler {
  public compile(): ICompilerOutput[] {
    if (!this.builder.Columns.some((c) => c.PrimaryKey)) {
      throw new InvalidArgument(`table ${this.builder.Table} has no primary key`);
    }

    return super.compile();
  }
}

@Injectable('orm-driver-sqlite-keyed')
@NewInstance()
export class KeyedSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(KeyedTableCompiler).as(TableQueryCompiler);
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
- `charset()` and `comment()` are dropped from the DDL.
- `json` and `bit` columns get no declared type.
- `truncate()` keeps the `AUTOINCREMENT` counter; new rows continue after the highest key ever used.
- `trackHistory()` throws `NotSupported`; `cloneTable()` has no SQLite implementation.
- `.after()` is ignored.
- `.modify()` rebuilds the whole table: it copies every row and holds the database's write lock until the copy commits. Several modified columns in one `alterTable()` share one rebuild.
- With foreign keys enforced, a table that another table references cannot be modified. Turn `PRAGMA foreign_keys` off for the migration, or rebuild both tables yourself.
- An `alterTable()` with several alterations compiles to several statements, which `SqlDriver.execute()` sends one after another: dropped columns, the table rename, then the column changes. A statement that fails stops the rest, and the ones before it stay applied.

## Best practices

- Declare booleans with `.notNull().default().value(0)` so they can be added to populated tables.
- Use `@Primary({ generated: 'uuid' })` or `'assigned'` for composite keys.
- Change a column's type, nullability or default with `.modify()` in an `alterTable()` of its own; the same migration then runs on MySQL, PostgreSQL and MSSQL.
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
// Don't: a modify shares its alterTable() with an add, so the rebuild refuses with NotSupported
await connection.schema().alterTable('articles', (table) => {
  table.string('Title', 300).notNull().modify();
  table.string('Slug').addColumn();
});

// Do
await connection.schema().alterTable('articles', (table) => {
  table.string('Title', 300).notNull().modify();
});
await connection.schema().alterTable('articles', (table) => {
  table.string('Slug').addColumn();
});
```

```ts
// Don't: SQLite drops the comment, so it documents nothing there
table.string('Title').comment('headline shown on the front page');

// Do: keep the explanation next to the model or the migration
table.string('Title').notNull(); // headline shown on the front page
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

### Give a column a default on a populated table

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('main')
export class ArticlesStatusDefault_2026_08_02_09_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    // rebuilds articles: rows, indexes and triggers are kept
    await connection.schema().alterTable('articles', (table) => {
      // modify() lives on the alter-column builder, default() returns the base one: keep a reference
      const status = table.string('Status', 16).notNull();
      status.default().value('draft');
      status.modify();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('articles', (table) => {
      table.string('Status', 16).notNull().modify();
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
