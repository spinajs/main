# Table reflection

`MySqlOrmDriver.tableInfo()` reads a table's columns from `INFORMATION_SCHEMA`, so models get their column list, primary key, defaults and JSON schemas from the live database. `MySqlTableExistsCompiler` answers "does this table exist" for migrations and `createTableIfAbsent`. `parseColumnDefault()` and `ResponseSchemaTypes` keep the reflected types honest.

## How it works

### `tableInfo(name, schema?)`

`Orm` calls it for every model at boot (`reloadTableInfo()`, with `Options.Database`), and the migration service calls it on its tracking table.

1. **Schema.** `schema ?? Options.Database`. Neither set: throws `OrmException("Cannot read table info for '<name>': no schema/database configured ...")`.
2. **Columns.** `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=? ORDER BY ORDINAL_POSITION`. The `ORDER BY` keeps the table's own column order.
3. **Existence.** `` SHOW FULL TABLES FROM `<schema>` WHERE `Tables_in_<schema>`=? ``. No row: returns `null`, as every driver does for a missing table.
4. **No columns.** Returns `null`.
5. **Indexes.** For a base table, `` SHOW INDEXES FROM `<name>` FROM `<schema>` ``. A view has no indexes; this step is skipped.
6. **Map.** Each column becomes an `IColumnDescriptor`:

| Field | Value |
| --- | --- |
| `Name` | `COLUMN_NAME` |
| `Type`, `NativeType` | `DATA_TYPE`, eg. `int`, `varchar`, `tinyint` (not the full `int(10) unsigned` form) |
| `Nullable` | `IS_NULLABLE === 'YES'` |
| `DefaultValue` | `parseColumnDefault(COLUMN_DEFAULT, DATA_TYPE)` |
| `PrimaryKey` | the column is in the `PRIMARY` index |
| `Unique` | the column is in any index with `Non_unique = 0`, including `PRIMARY` and multi-column unique indexes |
| `AutoIncrement` | `EXTRA` contains `auto_increment` |
| `Schema` | `schema` argument, else `Options.Database` |
| `MaxLength` | always `-1` |
| `Unsigned`, `Uuid`, `IsForeignKey`, `Virtual`, `Ignore`, `Aggregate` | always `false` |
| `Comment` | always `''` |
| `ForeignKeyDescription`, `Converter` | always `null` |

### `parseColumnDefault(raw, dataType)`

`INFORMATION_SCHEMA.COLUMNS.COLUMN_DEFAULT` is text, so `DEFAULT 0` on a `FLOAT` arrives as `'0'`. `parseColumnDefault()` returns a number when:

- `dataType` is `tinyint`, `smallint`, `mediumint`, `int`, `integer`, `bigint`, `float` or `double`; and
- `raw` is not blank and `Number(raw)` is finite.

Everything else returns `raw` unchanged: `null`, `undefined`, string defaults, expressions such as `CURRENT_TIMESTAMP` or `(uuid())`, and `DECIMAL` / `NUMERIC` defaults, which stay strings like their values.

### `ResponseSchemaTypes`

`mysql2` returns `DECIMAL` and `NUMERIC` values as strings (`decimalNumbers` is off). `MySqlOrmDriver.ResponseSchemaTypes` maps `decimal`, `newdecimal` and `numeric` to `{ type: 'string' }`, and `buildModelJsonSchema(d, 'response')` uses it for the model's `ResponseSchema`. The request schema (`Schema`) keeps `DECIMAL` as a number.

### `TableExistsCompiler`

`schema().tableExists(name, schema?)` compiles through `MySqlTableExistsCompiler` and resolves `true` when one row comes back:

- with a schema (a MySQL database): `SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1;`
- without: `... WHERE table_name = ? AND table_schema = DATABASE() LIMIT 1;` The probe is scoped to the connection's own database, so a table of the same name in another database does not count.

`information_schema.tables` lists views too, so a view of that name reports the table as present.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Connections[].Database` | `string` | | | Default schema of `tableInfo()`. Required for reflection. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Table reflection | `tableInfo(name, schema?)` on the driver (public) | `MySqlOrmDriver.tableInfo()` | | Override in a driver subclass; call `super.tableInfo()` and enrich the descriptors. |
| Default parsing | `parseColumnDefault(raw, dataType)` (exported function) | numeric literals only | | Call it from your own `tableInfo()`; it has no registration. |
| Response schema types | `ResponseSchemaTypes` (public, readonly, on the driver) | `decimal`, `newdecimal`, `numeric` as strings | | Redeclare the property in a driver subclass. |
| Table-exists probe | `TableExistsCompiler`; `@NewInstance()`, constructor `(builder: TableExistsQueryBuilder)`; registered in `MySqlOrmDriver.resolve()` | `MySqlTableExistsCompiler` | | Implement `TableExistsCompiler.compile()` and register `.as(TableExistsCompiler)` after `super.resolve()`. |

### Table reflection: custom implementation

`tableInfo()` leaves `Unsigned`, `MaxLength` and `Comment` empty. This subclass fills them from `COLUMN_TYPE`, `CHARACTER_MAXIMUM_LENGTH` and `COLUMN_COMMENT`, so admin screens built from model descriptors can show column lengths and comments. It keeps `NativeType` as `DATA_TYPE`, because value converters are looked up by it.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { IColumnDescriptor, QueryContext } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

type ColumnDetails = { COLUMN_NAME: string; COLUMN_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null; COLUMN_COMMENT: string };

@Injectable('orm-driver-mysql')
@NewInstance()
export class DescribingMySqlDriver extends MySqlOrmDriver {
  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const columns = await super.tableInfo(name, schema);

    if (!columns) {
      return columns;
    }

    const details = (await this.executeOnDb(
      'SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ?',
      [name, schema ?? this.Options.Database],
      QueryContext.Select,
    )) as ColumnDetails[];

    for (const column of columns) {
      const d = details.find((x) => x.COLUMN_NAME === column.Name);
      if (d) {
        column.Unsigned = d.COLUMN_TYPE.includes('unsigned');
        column.MaxLength = d.CHARACTER_MAXIMUM_LENGTH ?? -1;
        column.Comment = d.COLUMN_COMMENT;
      }
    }

    return columns;
  }
}
```

### Response schema types: custom implementation

A driver that turns `decimalNumbers` on (through its own `connect()`, see [Connection setup](01-mysql-driver.md#connection-setup-custom-implementation)) must also say that `DECIMAL` arrives as a number, or the generated OpenAPI response schema rejects every row.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

@Injectable('orm-driver-mysql-float-decimals')
@NewInstance()
export class FloatDecimalMySqlDriver extends MySqlOrmDriver {
  // matches a connect() override that passes decimalNumbers: true to mysql2
  public readonly ResponseSchemaTypes: Readonly<Record<string, unknown>> = {};
}
```

### Table-exists probe: custom implementation

Count only base tables, so a view named like a migration's table does not make `createTableIfAbsent` skip the `CREATE TABLE`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, TableExistsCompiler, TableExistsQueryBuilder } from '@spinajs/orm';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

@NewInstance()
export class BaseTableExistsCompiler implements TableExistsCompiler {
  constructor(protected builder: TableExistsQueryBuilder) {}

  public compile(): ICompilerOutput {
    const schema = this.builder.Database ? 'table_schema = ?' : 'table_schema = DATABASE()';
    const bindings = this.builder.Database ? [this.builder.Database, this.builder.Table] : [this.builder.Table];

    return {
      bindings,
      expression: `SELECT * FROM information_schema.tables WHERE ${schema} AND table_name = ? AND table_type = 'BASE TABLE' LIMIT 1;`,
    };
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class StrictMigrationsMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(BaseTableExistsCompiler).as(TableExistsCompiler);
  }
}
```

## Important behaviour

- A missing table returns `null`, as on SQLite, PostgreSQL and MSSQL. Whether a model whose table is missing fails `Orm.resolve()` is decided by `db.StrictTableCheck`, the same on every driver. See [Connections](../orm/01-connections.md).
- `NativeType` is `DATA_TYPE`, so a `BOOLEAN` column reflects as `tinyint` and gets no boolean converter by type. Mark it `@Bool()`.
- Every column of a multi-column unique index reflects as `Unique: true`, although each column alone is not unique.
- Reflection issues three queries per table at boot and runs them through `withReconnect()`.
- `ResponseSchemaTypes` is keyed by `IColumnDescriptor.Type`, the lower-case `DATA_TYPE`.

## Best practices

- Set `Database` on every MySQL connection; reflection, `tableExists()` and the migration table depend on it.
- Apply migrations before the app serves (`migrate-up` in the deploy step, or `Migration.OnStartup`, applied when the `Orm` resolves): models then reflect the migrated columns. The `Orm` reads the tables after its startup migrations, and `migrate-up` re-reads the ones its migrations touched.
- Declare `@Bool()`, `@DateTime()` and similar converters on columns whose `DATA_TYPE` does not say their JS type.

## Patterns and antipatterns

```ts
// Don't: rewrite NativeType to the full COLUMN_TYPE; converter lookup by type stops matching
column.NativeType = d.COLUMN_TYPE; // 'tinyint(1)'

// Do: keep NativeType, put the detail in the fields made for it
column.Unsigned = d.COLUMN_TYPE.includes('unsigned');
```

## Examples

### List the nullable columns of the orders table

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function nullableOrderColumns(): Promise<string[]> {
  const shop = DI.resolve<OrmDriver>('OrmConnection', ['shop'])!;
  const columns = await shop.tableInfo('orders');

  return (columns ?? []).filter((c) => c.Nullable).map((c) => c.Name);
}
```

### Read a column default as the column's type

```ts sample
import { parseColumnDefault } from '@spinajs/orm-mysql';

// 0 (number): a FLOAT default is a numeric literal
export const discount = parseColumnDefault('0', 'float');

// 'CURRENT_TIMESTAMP' (unchanged): an expression, not a value
export const createdAt = parseColumnDefault('CURRENT_TIMESTAMP', 'datetime');

// '0.00' (unchanged): DECIMAL stays a string, like its values
export const total = parseColumnDefault('0.00', 'decimal');
```

## Related

- [Models](../orm/02-models.md): how reflected columns merge with decorator metadata.
- [JSON schema](../orm/11-json-schema.md): `Schema` and `ResponseSchema`, where `ResponseSchemaTypes` applies.
- [Migrations](../orm/10-migrations.md): `createTableIfAbsent` and the tracking-table probe.
- [MySQL driver](01-mysql-driver.md): where `decimalNumbers` is set.
