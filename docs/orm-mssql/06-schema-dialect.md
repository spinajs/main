# Schema dialect

What the schema builder (`driver.schema()`, migrations) produces on SQL Server: tables, columns, indexes, databases, views and existence checks. The driver replaces the table, column, database, view and existence compilers; column **types** still use the shared MySQL spelling, so pick types that are valid T-SQL or replace the column compiler.

## How it works

`driver.schema().createTable('orders', (table) => { ... })` compiles like this:

1. `TableQueryBuilder.toDB()` resolves `TableQueryCompiler`: `MsSqlTableQueryCompiler`.
2. `_table()` writes `CREATE TABLE <name>` through `MsSqlTableAliasCompiler`, so the name gets the `[database].[schema].` prefix; see [Query dialect](05-query-dialect.md).
3. `_columns()` compiles each column with `ColumnQueryCompiler` (`MsSqlColumnQueryCompiler`) and appends ` PRIMARY KEY` to primary key columns.
4. Every column marked `unique()` is collected into one table-level `UNIQUE(<names>)`.
5. `_foreignKeys()` compiles each foreign key with the shared `ForeignKeyQueryCompiler`.
6. The result is one statement: `CREATE TABLE [dbo].[orders] (<columns> , UNIQUE(...) ,<foreign keys>)`.

`MsSqlColumnQueryCompiler` is `SqlColumnQueryCompiler` with these changes: `autoIncrement()` writes `IDENTITY(1,1)` instead of `AUTO_INCREMENT`, `collation()` is written unquoted, and `caseSensitive()` writes `COLLATE Latin1_General_100_BIN2` and makes a `string()` column `NVARCHAR`.

### Column types

What each `TableQueryBuilder` method writes, and whether SQL Server accepts it:

| Method | Writes | Valid T-SQL |
| --- | --- | --- |
| `int`, `smallint`, `tinyint`, `bigint` | `INT`, `SMALLINT`, `TINYINT`, `BIGINT` | yes |
| `bit` | `BIT` | yes |
| `float`, `decimal`, `double` (`name, precision = 8, scale = 2`) | `FLOAT(8,2)`, `DECIMAL(8,2)`, `DOUBLE(8,2)` | `DECIMAL` only |
| `string(name, length = 255)` | `VARCHAR(255)`; `NVARCHAR(255)` with `caseSensitive()` | yes (Unicode only as `NVARCHAR`) |
| `text` | `TEXT` | yes (deprecated type) |
| `tinytext`, `mediumtext`, `longtext` | same name | no |
| `date`, `time`, `dateTime` | `DATE`, `TIME`, `DATETIME` | yes |
| `timestamp` | `TIMESTAMP` | accepted, but it is a row version, not a date |
| `binary(name, size)`, `uuid` | `BINARY(size)`, `BINARY(16)` | yes |
| `boolean` | `BOOLEAN` | no: use `bit` |
| `json` | `JSON` | no: use `text` or a custom column compiler |
| `enum`, `set` | `ENUM(...)`, `SET(...)` | no |
| `mediumint`, `tinyblob`, `mediumblob`, `longblob` | same name | no |

| Modifier | Writes | Valid T-SQL |
| --- | --- | --- |
| `notNull()` | `NOT NULL` | yes |
| `autoIncrement()` | `IDENTITY(1,1)` | yes |
| `primaryKey()` | ` PRIMARY KEY` (added by the table compiler) | yes |
| `unique()` | `UNIQUE` on the column **and** in the table-level `UNIQUE(...)` | yes; creates two unique constraints |
| `unsigned()`, `comment()` | `UNSIGNED`, `COMMENT '...'` | no |
| `charset()` | nothing: T-SQL has no column character set, the collation carries the code page | yes |
| `collation(name)` | `COLLATE name`, unquoted; a name outside `[A-Za-z0-9_]` throws `InvalidArgument` | yes |
| `caseSensitive()` | `COLLATE Latin1_General_100_BIN2`, unless `collation()` names one; a `string()` column becomes `NVARCHAR(n)`, since a binary collation on `VARCHAR` limits it to code page 1252 | yes; `=` still ignores trailing blanks |
| `default()` | see [Important behaviour](#important-behaviour) | fails |

### Other schema statements

| Builder call | Class | T-SQL |
| --- | --- | --- |
| `schema().tableExists(name, database?)` | `MsSqlTableExistsCompiler` | `SELECT TOP(1) * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? [AND TABLE_CATALOG=?] ORDER BY TABLE_NAME`; `true` when a row comes back |
| `schema().lockTable(name)` | `MsSqlLockTableQueryCompiler` | `SELECT COUNT(*) FROM [name] WITH (TABLOCK, HOLDLOCK)` |
| `driver.index()...` | shared `SqlIndexQueryCompiler` | `CREATE [UNIQUE] INDEX [name] ON [table] ([cols]);` |
| `schema().dropTable(name).ifExists()` | shared `SqlDropTableQueryCompiler` | `DROP TABLE IF EXISTS <table>` |
| `driver.truncate(name)` | `SqlTruncateTableQueryCompiler` (registered explicitly) | `TRUNCATE TABLE <table>` |
| `schema().createDatabase(name)` | `MsSqlCreateDatabaseQueryCompiler` | `CREATE DATABASE [name]` |
| ... `.collation(c)` | | `CREATE DATABASE [name] COLLATE c` |
| ... `.ifNotExists()` | | `IF DB_ID('name') IS NULL EXEC('CREATE DATABASE [name]')` |
| ... `.charset(c)` | | throws `NotSupported('mssql has no CHARACTER SET for a database, use collation() instead')` |
| `schema().dropDatabase(name).ifExists()` | `MsSqlDropDatabaseQueryCompiler` | `DROP DATABASE IF EXISTS [name]` |
| `schema().createView(name, v => v.as(...))` | `MsSqlCreateViewCompiler` | `CREATE VIEW [name] AS ...`, bindings inlined with `MsSqlLiteralQuoter` |
| ... `.orReplace()` | | `CREATE OR ALTER VIEW` |
| ... `.columns([...])`, `.checkOption()` | | `([a],[b])`, `WITH CHECK OPTION` |
| ... `.ifNotExists()`, `.temporary()`, `.algorithm()`, `.security()`, `.checkOption('CASCADED' \| 'LOCAL')`, a `database()` prefix | | throw `MethodNotImplemented` |
| `schema().dropView(name).ifExists()` | shared `SqlDropViewQueryCompiler` | `DROP VIEW IF EXISTS [name]` |
| `schema().createEvent()`, `dropEvent()` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` | throw `MethodNotImplemented('<Driver> has no native scheduled events')`, `<Driver>` being the connection's driver string |
| `schema().alterTable()`, `alterColumn`, `cloneTable()` | none registered | fail |

## Services and extension points

All in the driver's child container, registered by `MsSqlOrmDriver.resolve()`. The MSSQL classes are not exported; extend the shared class from `@spinajs/orm-sql` or implement the abstract token from `@spinajs/orm`.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Column definition | `ColumnQueryCompiler`, new instance | `MsSqlColumnQueryCompiler` | `SqlColumnQueryCompiler` | Extend `SqlColumnQueryCompiler`; reassign entries of `this._statementsMappings` in the constructor, and override `charsetName()` / `collationName()` to change the character set and collation clauses. |
| `CREATE TABLE` | `TableQueryCompiler`, new instance | `MsSqlTableQueryCompiler` | `SqlTableQueryCompiler` (adds history triggers, MySQL spelling) | Extend `SqlTableQueryCompiler`; override `compile()`, `_table()`, `_columns()` or `_foreignKeys()`. |
| Column defaults | `DefaultValueBuilder` | **none** | `SqlDefaultValueBuilder` (`@spinajs/orm-sql`) | Extend `SqlDefaultValueBuilder`, decorate `@NewInstance()`, register `.as(DefaultValueBuilder)`. |
| Table existence | `TableExistsCompiler`, new instance | `MsSqlTableExistsCompiler` | | Implement `TableExistsCompiler.compile()`; return a query that yields a row when the table exists. |
| Databases | `CreateDatabaseCompiler`, `DropDatabaseCompiler`, new instance | `MsSqlCreateDatabaseQueryCompiler`, `MsSqlDropDatabaseQueryCompiler` | `SqlCreateDatabaseQueryCompiler`, `SqlDropDatabaseQueryCompiler` (MySQL spelling) | Extend the abstract token, implement `compile()`. |
| Views | `CreateViewCompiler`, new instance | `MsSqlCreateViewCompiler` | `SqlCreateViewQueryCompiler` | Extend `SqlCreateViewQueryCompiler`; override the hooks (`_replace()`, `_name()`, `_checkOption()`, ...). See [View compiler hooks](../orm-sql/06-view-compiler-hooks.md). |
| Truncate | `TruncateTableQueryCompiler` | `SqlTruncateTableQueryCompiler` | | Register your own `.as(TruncateTableQueryCompiler)`. |
| Scheduled events | `EventQueryCompiler`, `DropEventQueryCompiler` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` | | Implement with SQL Server Agent jobs, and override `supportedFeatures()` to return `events: true`. |
| Table changes | `AlterTableQueryCompiler`, `AlterColumnQueryCompiler`, `TableCloneQueryCompiler`, `TableHistoryQueryCompiler` | **none** | the shared `Sql*` classes write MySQL syntax | Implement the token in T-SQL and register it. |

### Column definition: custom implementation

Write Unicode strings, `BIT` booleans, `DATETIME2` datetimes and `NVARCHAR(MAX)` for text and JSON:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ColumnQueryBuilder, ColumnQueryCompiler } from '@spinajs/orm';
import { SqlColumnQueryCompiler } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@NewInstance()
export class TsqlColumnQueryCompiler extends SqlColumnQueryCompiler {
  constructor(builder: ColumnQueryBuilder) {
    super(builder);

    this._statementsMappings.autoincrement = () => 'IDENTITY(1,1)';
    this._statementsMappings.string = (column: ColumnQueryBuilder) => `NVARCHAR(${column.Args[0] ?? 255})`;
    this._statementsMappings.text = () => 'NVARCHAR(MAX)';
    this._statementsMappings.longtext = () => 'NVARCHAR(MAX)';
    this._statementsMappings.json = () => 'NVARCHAR(MAX)';
    this._statementsMappings.boolean = () => 'BIT';
    this._statementsMappings.dateTime = () => 'DATETIME2';
    // T-SQL has no column comments; an empty entry is dropped from the definition
    this._statementsMappings.comment = () => '';
  }

  // T-SQL has no column character set: skip charset(). collationName() is the matching hook
  // for what a column's COLLATE clause says (it also supplies the binary collation of caseSensitive())
  protected charsetName(): string {
    return '';
  }
}

@Injectable('orm-driver-mssql-unicode')
@NewInstance()
export class UnicodeMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(TsqlColumnQueryCompiler).as(ColumnQueryCompiler);
  }
}
```

### Column defaults: custom implementation

With no `DefaultValueBuilder` registered, `default()` cannot be used on MSSQL. Register one; `SqlColumnQueryCompiler` turns its `Value` into `DEFAULT '...'` or `DEFAULT n`, and its `Query` into `DEFAULT <sql>`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DefaultValueBuilder, RawQuery } from '@spinajs/orm';
import { SqlDefaultValueBuilder } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@NewInstance()
export class TsqlDefaultValueBuilder<T> extends SqlDefaultValueBuilder<T> {
  public date(): T {
    this.Query = RawQuery.create('CAST(GETDATE() AS DATE)');
    return this.Owner;
  }

  public dateTime(): T {
    this.Query = RawQuery.create('SYSDATETIME()');
    return this.Owner;
  }
}

@Injectable('orm-driver-mssql-defaults')
@NewInstance()
export class DefaultsMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(TsqlDefaultValueBuilder).as(DefaultValueBuilder);
  }
}
```

Then `table.dateTime('CreatedAt').notNull().default().dateTime()` writes `[CreatedAt] DATETIME NOT NULL DEFAULT SYSDATETIME()`.

## Important behaviour

- **`default()` fails.** No `DefaultValueBuilder` is registered, so the container instantiates the abstract class itself, whose `value()`, `date()`, `dateTime()` and `raw()` are not implemented: calling one throws a `TypeError`. Register a builder as above.
- **Unregistered schema tokens fail on first use**, not at connect: `alterTable()`, `alterColumn`, `cloneTable()` and `withRecursive()` reach an abstract compiler with no `compile()`. The driver leaves them out so MySQL syntax is never sent to SQL Server.
- **`trackHistory()` is ignored.** `MsSqlTableQueryCompiler` does not compile table history; the table is created without it.
- **`temporary()` and `ifExists()` on `createTable` write MySQL syntax** (`CREATE TEMPORARY TABLE`, `IF NOT EXISTS`), which SQL Server rejects.
- **`UNIQUE(...)` names are not quoted.** A unique column named after a reserved word, such as `Key`, breaks the statement.
- **`tableExists()` ignores `Options.Schema`.** A table of the same name in another schema of the database counts as existing.
- **`CREATE DATABASE` is guarded with `EXEC`** because it must be alone in its batch; the name is escaped by doubling `'`.
- **A view body's bindings are inlined** with `MsSqlLiteralQuoter`: strings as `N'...'`, booleans as `1` / `0`. A string containing a backtick throws `InvalidArgument`.
- **DDL is transactional.** `CREATE TABLE` and `ALTER TABLE` roll back with the transaction, so `MigrationTransactionMode.PerMigration` is atomic; see [Transactions](03-transactions.md).

## Best practices

- In migrations for MSSQL, use `int`, `bigint`, `bit`, `decimal`, `string`, `text`, `date`, `dateTime` and `binary`; or register `TsqlColumnQueryCompiler`.
- Declare unique columns with `unique()` only; avoid a separate `driver.index().unique()` on the same column.
- Use `orReplace()` for views you redeploy: it becomes `CREATE OR ALTER VIEW`.

## Patterns and antipatterns

```ts
// Don't: BOOLEAN and JSON are not T-SQL types, default() throws
table.boolean('Active').default().value(1);
table.json('Settings');

// Do
table.bit('Active').notNull();
table.text('Settings');
```

## Examples

### Create the catalogue tables in a migration

```ts sample
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

@Migration('mssql')
export class Catalogue_2024_05_01_10_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('products', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Sku', 32).notNull().unique();
      table.string('Name', 200).notNull();
      table.decimal('Price', 10, 2).notNull();
      table.bit('Active').notNull();
      table.dateTime('CreatedAt').notNull();
    });

    await connection.schema().createView('active_products', (view) => view.orReplace().as((select) => select.from('products').where('Active', true)));
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropView('active_products').ifExists();
    await connection.schema().dropTable('products').ifExists();
  }
}
```

### Create a tenant database with a UTF-8 collation

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function createTenantDatabase(tenant: string): Promise<void> {
  const driver = DI.get(Orm)!.Connections.get('mssql')!;
  await driver.schema().createDatabase(`tenant_${tenant}`, (db) => db.ifNotExists().collation('Latin1_General_100_CI_AS_SC_UTF8'));
}
```

## Related

- [Schema builder](../orm/09-schema-builder.md): every schema builder method.
- [Migrations](../orm/10-migrations.md): `@Migration`, `OrmMigration`, transaction modes.
- [Query compilers](../orm-sql/02-query-compilers.md): `SqlColumnQueryCompiler._statementsMappings` and the other shared compilers.
- [Value converters and default values](../orm-sql/05-value-converters-and-defaults.md): `SqlDefaultValueBuilder`.
- [View compiler hooks](../orm-sql/06-view-compiler-hooks.md): the hooks `MsSqlCreateViewCompiler` overrides.
