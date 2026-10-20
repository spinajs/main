# Schema dialect

What the schema builder (`driver.schema()`, migrations) produces on SQL Server: tables, columns, table and column changes, indexes, databases, views and existence checks. The driver replaces the table, column, alter-table, alter-column, default value, database, view and existence compilers; column types it does not map still use the shared MySQL spelling, so pick types that are valid T-SQL or replace the column compiler.

## How it works

`driver.schema().createTable('orders', (table) => { ... })` compiles like this:

1. `TableQueryBuilder.toDB()` resolves `TableQueryCompiler`: `MsSqlTableQueryCompiler`.
2. `compile()` throws `MethodNotImplemented('orm-driver-mssql has no table history support')` for `trackHistory()`.
3. `_table()` writes `CREATE TABLE <name>` through `MsSqlTableAliasCompiler`, so the name gets the `[database].[schema].` prefix; see [Query dialect](05-query-dialect.md). With `ifExists()` it writes `IF OBJECT_ID(N'<name>', N'U') IS NULL CREATE TABLE <name>`. `temporary()` throws `NotSupported`: a SQL Server temporary table is one whose name starts with `#`.
4. `_columns()` compiles each column with `ColumnQueryCompiler` (`MsSqlColumnQueryCompiler`) and appends ` PRIMARY KEY` to primary key columns. A `unique()` column carries an inline `UNIQUE`.
5. `_foreignKeys()` compiles each foreign key with the shared `ForeignKeyQueryCompiler`.
6. The result is one statement: `CREATE TABLE [dbo].[orders] (<columns>,<foreign keys>)`.

`MsSqlColumnQueryCompiler` is `SqlColumnQueryCompiler` with the T-SQL spelling of `autoIncrement()` (`IDENTITY(1,1)`), `boolean`, `json`, `enum`, `set`, `text` and its variants, `unsigned()`, `charset()`, `comment()`, `collation()` and `exact()`, listed below. `text`, `tinytext`, `mediumtext` and `longtext` write `NVARCHAR(MAX)` because `TEXT` is deprecated and cannot be compared with `=`. SQL Server has no JSON type, so `supportedFeatures().nativeJson` is `false`.

### Column types

What each `TableQueryBuilder` method writes, and whether SQL Server accepts it:

| Method | Writes | Valid T-SQL |
| --- | --- | --- |
| `int`, `smallint`, `tinyint`, `bigint` | `INT`, `SMALLINT`, `TINYINT`, `BIGINT` | yes |
| `bit` | `BIT` | yes |
| `float`, `decimal`, `double` (`name, precision = 8, scale = 2`) | `FLOAT(8,2)`, `DECIMAL(8,2)`, `DOUBLE(8,2)` | `DECIMAL` only |
| `string(name, length = 255)` | `VARCHAR(255)`; `NVARCHAR(255)` with `exact()` | yes (Unicode only as `NVARCHAR`) |
| `text`, `tinytext`, `mediumtext`, `longtext` | `NVARCHAR(MAX)` | yes |
| `date`, `time` | `DATE`, `TIME` | yes |
| `dateTime`, `timestamp` | `DATETIMEOFFSET(3)` | yes |
| `binary(name, size)`, `uuid` | `BINARY(size)`, `BINARY(16)` | yes |
| `boolean` | `BIT` | yes |
| `json` | `NVARCHAR(MAX)` | yes |
| `enum`, `set` | `NVARCHAR(255)`; the allowed values are not enforced | yes |
| `mediumint`, `tinyblob`, `mediumblob`, `longblob` | same name | no |

| Modifier | Writes | Valid T-SQL |
| --- | --- | --- |
| `notNull()` | `NOT NULL` | yes |
| `autoIncrement()` | `IDENTITY(1,1)` | yes |
| `primaryKey()` | ` PRIMARY KEY` (added by the table compiler) | yes |
| `unique()` | `UNIQUE` on the column | yes |
| `unsigned()`, `comment()` | nothing: T-SQL has neither | yes |
| `charset()` | throws `NotSupported('mssql has no CHARACTER SET for a column, use collation() instead')` | |
| `collation(name)` | `COLLATE name`, unquoted; a name outside `[A-Za-z0-9_]` throws `InvalidArgument` | yes |
| `exact()` | `COLLATE Latin1_General_100_BIN2`, unless `collation()` names one; a `string()` column becomes `NVARCHAR(n)`, since a binary collation on `VARCHAR` limits it to code page 1252 | yes; compares byte for byte. `=` still ignores trailing spaces: compare with `SqlExpressions.equalsExactly()` where they matter |
| `default().value(v)` | `DEFAULT 'v'` for a string, `DEFAULT v` for a number | yes |
| `default().date()`, `default().dateTime()` | `DEFAULT CAST(SYSUTCDATETIME() AS DATE)` (the UTC date), `DEFAULT SYSDATETIMEOFFSET()` | yes |
| `default().raw(query)` | `DEFAULT <query>` | as written |

### Other schema statements

| Builder call | Class | T-SQL |
| --- | --- | --- |
| `schema().tableExists(name, database?)` | `MsSqlTableExistsCompiler` | `SELECT TOP(1) * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? [AND TABLE_CATALOG=?] ORDER BY TABLE_NAME`; `true` when a row comes back |
| `driver.lockTableShared(name)`, inside a transaction | `MsSqlOrmDriver` | `SELECT COUNT(*) FROM [name] WITH (TABLOCK, HOLDLOCK)` |
| `driver.index()...` | shared `SqlIndexQueryCompiler` | `CREATE [UNIQUE] INDEX [name] ON [table] ([cols]);` |
| `driver.index().name(n).table(t).drop()` | shared `SqlIndexQueryCompiler` | `DROP INDEX [n] ON [t]` |
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
| `schema().cloneTable()` | none registered | throws `TypeError` |

### Altering tables

`schema().alterTable(name, t => ...)` compiles with `MsSqlAlterTableQueryCompiler` and `MsSqlAlterColumnQueryCompiler`, one statement per change, in this order:

| Alteration | T-SQL | Notes |
| --- | --- | --- |
| `t.dropColumn(c)` | `ALTER TABLE <table> DROP COLUMN [c]` | |
| `t.string(c, 64).notNull()` (add) | `ALTER TABLE <table> ADD [c] VARCHAR(64) NOT NULL [PRIMARY KEY]` | `.after(col)` throws `NotSupported`: SQL Server always appends. |
| `t.string(c, 64).modify()` | `ALTER TABLE <table> ALTER COLUMN [c] VARCHAR(64) NULL`; `NOT NULL` when `notNull()` | Type, collation and nullability only. `default()`, `autoIncrement()`, `primaryKey()` or `unique()` in a modify throw `NotSupported`: they are constraints of their own. |
| `t.string(old).rename(new)` | `EXEC sp_rename N'[schema].[table].[old]', N'new', N'COLUMN'` | |
| `t.rename(new)` | `EXEC sp_rename N'[schema].[table]', N'new'` | Written last, so the statements before it find the table under its current name. |

## Services and extension points

All in the driver's child container, registered by `MsSqlOrmDriver.resolve()`. The MSSQL classes are not exported; extend the shared class from `@spinajs/orm-sql` or implement the abstract token from `@spinajs/orm`.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Column definition | `ColumnQueryCompiler`, new instance | `MsSqlColumnQueryCompiler` | `SqlColumnQueryCompiler` | Extend `SqlColumnQueryCompiler`; reassign entries of `this._statementsMappings` in the constructor, and override `charsetName()` / `collationName()` to change the character set and collation clauses. |
| `CREATE TABLE` | `TableQueryCompiler`, new instance | `MsSqlTableQueryCompiler` | `SqlTableQueryCompiler` (adds history triggers, MySQL spelling) | Extend `SqlTableQueryCompiler`; override `compile()`, `_table()`, `_columns()` or `_foreignKeys()`. |
| Column defaults | `DefaultValueBuilder`, new instance | `MsSqlDefaultValueBuilder` | `SqlDefaultValueBuilder` (`@spinajs/orm-sql`, `CURRENT_DATE()` is not T-SQL) | Extend `SqlDefaultValueBuilder`, decorate `@NewInstance()`, register `.as(DefaultValueBuilder)`. |
| Table existence | `TableExistsCompiler`, new instance | `MsSqlTableExistsCompiler` | | Implement `TableExistsCompiler.compile()`; return a query that yields a row when the table exists. |
| Databases | `CreateDatabaseCompiler`, `DropDatabaseCompiler`, new instance | `MsSqlCreateDatabaseQueryCompiler`, `MsSqlDropDatabaseQueryCompiler` | `SqlCreateDatabaseQueryCompiler`, `SqlDropDatabaseQueryCompiler` (MySQL spelling) | Extend the abstract token, implement `compile()`. |
| Views | `CreateViewCompiler`, new instance | `MsSqlCreateViewCompiler` | `SqlCreateViewQueryCompiler` | Extend `SqlCreateViewQueryCompiler`; override the hooks (`_replace()`, `_name()`, `_checkOption()`, ...). See [View compiler hooks](../orm-sql/06-view-compiler-hooks.md). |
| Truncate | `TruncateTableQueryCompiler` | `SqlTruncateTableQueryCompiler` | | Register your own `.as(TruncateTableQueryCompiler)`. |
| Scheduled events | `EventQueryCompiler`, `DropEventQueryCompiler` | `UnsupportedEventQueryCompiler`, `UnsupportedDropEventQueryCompiler` | | Implement with SQL Server Agent jobs, and override `supportedFeatures()` to return `events: true`. |
| Table changes | `AlterTableQueryCompiler`, new instance | `MsSqlAlterTableQueryCompiler` | `SqlAlterTableQueryCompiler` (`RENAME TO`) | Extend `SqlAlterTableQueryCompiler`; override `compile()`. The MSSQL class writes `DROP COLUMN`, both `sp_rename` calls and the `ALTER TABLE` prefix for each column change. |
| Column changes | `AlterColumnQueryCompiler`, new instance | `MsSqlAlterColumnQueryCompiler` | `SqlAlterColumnQueryCompiler` (`MODIFY`, `RENAME COLUMN`, `AFTER`) | Extend `SqlAlterColumnQueryCompiler`; override `_add()` or `_modify()`. Its `_rename()` throws: the table compiler writes column renames. |
| Table cloning and history | `TableCloneQueryCompiler`, `TableHistoryQueryCompiler` | **none** | the shared `Sql*` classes write MySQL syntax | Implement the token in T-SQL and register it. |

### Column definition: custom implementation

Write Unicode strings, `BIT` booleans and `NVARCHAR(MAX)` for text and JSON. The MSSQL compiler is not exported, so this one extends the shared compiler and restates the T-SQL mappings it needs:

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
    // extends the shared compiler, so the MSSQL text, json, boolean and collation spellings are restated
    this._statementsMappings.text = () => 'NVARCHAR(MAX)';
    this._statementsMappings.longtext = () => 'NVARCHAR(MAX)';
    this._statementsMappings.json = () => 'NVARCHAR(MAX)';
    this._statementsMappings.boolean = () => 'BIT';
    this._statementsMappings.collation = (name: string) => `COLLATE ${name}`;
    // T-SQL has no column comments; an empty entry is dropped from the definition
    this._statementsMappings.comment = () => '';
    this._statementsMappings.unsigned = () => '';
  }

  // T-SQL has no column character set: skip charset()
  protected charsetName(): string {
    return '';
  }

  protected collationName(): string {
    return this.builder.Collation || (this.builder.Exact ? 'Latin1_General_100_BIN2' : '');
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

`MsSqlDefaultValueBuilder` already writes `CAST(SYSUTCDATETIME() AS DATE)` for `date()` and `SYSDATETIMEOFFSET()` for `dateTime()`. Register your own to change a default; `SqlColumnQueryCompiler` turns its `Value` into `DEFAULT '...'` or `DEFAULT n`, and its `Query` into `DEFAULT <sql>`. This one takes `date()` from the server's local clock instead of UTC, so near midnight it is a day off the date the other dialects write:

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

Then `table.date('Day').default().date()` writes `[Day] DATE DEFAULT CAST(GETDATE() AS DATE)`.

## Important behaviour

- **Unregistered schema tokens fail on first use** with a `TypeError`, not at connect: `cloneTable()` and `withRecursive()` reach an abstract compiler with no `compile()`. The driver leaves them out so MySQL syntax is never sent to SQL Server.
- **`ALTER COLUMN` changes only type, collation and nullability.** Restate `notNull()`, or the column becomes nullable. SQL Server keeps defaults, identity and keys as constraints, and refuses to alter a column a `PRIMARY KEY` depends on; drop and re-create the constraint with raw statements. Dropping a column that has a default needs its default constraint dropped first.
- **The `sp_rename` arguments are literals.** The new name is not bracketed, because brackets in it would become part of the name; a `database()` prefix calls `[database].sys.sp_rename`.
- **`trackHistory()` throws** `MethodNotImplemented`; SQL Server's equivalent is a temporal table, which the driver does not create.
- **`temporary()` on `createTable` throws** `NotSupported`. Create the table with a `#` name through a `RawQuery` instead.
- **`enum` and `set` columns do not enforce their values.** They are plain `NVARCHAR(255)` columns.
- **`tableExists()` ignores `Options.Schema`.** A table of the same name in another schema of the database counts as existing.
- **`CREATE DATABASE` is guarded with `EXEC`** because it must be alone in its batch; the name is escaped by doubling `'`.
- **A view body's bindings are inlined** with `MsSqlLiteralQuoter`: strings as `N'...'`, booleans as `1` / `0`. A string containing a backtick throws `InvalidArgument`.
- **DDL is transactional.** `CREATE TABLE` and `ALTER TABLE` roll back with the transaction, so `MigrationTransactionMode.PerMigration` is atomic; see [Transactions](03-transactions.md).

## Best practices

- In migrations for MSSQL, use `int`, `bigint`, `bit`, `boolean`, `decimal`, `string`, `text`, `json`, `date`, `dateTime` and `binary`; or register `TsqlColumnQueryCompiler`.
- Declare unique columns with `unique()` only; avoid a separate `driver.index().unique()` on the same column.
- Use `orReplace()` for views you redeploy: it becomes `CREATE OR ALTER VIEW`.

## Patterns and antipatterns

```ts
// Don't: MEDIUMINT and DOUBLE are not T-SQL types
table.mediumint('Views');
table.double('Ratio');

// Do
table.int('Views');
table.decimal('Ratio', 10, 4);
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
