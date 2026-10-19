# Inserts and upserts

On SQL Server an insert is `INSERT INTO ... VALUES (...); SELECT SCOPE_IDENTITY() as ID;`, an upsert is a `MERGE` statement, and `INSERT IGNORE` does not exist. The driver registers no `ServerResponseMapper`, so every model insert path throws after the row is written until you register one. This page shows the mapper to register.

## How it works

### Builder insert

1. `driver.insert().into('orders').values({...})` builds an `InsertQueryBuilder` with `QueryContext.Insert`.
2. `MsSqlInsertQueryCompiler.compile()` throws `OrmException('mssql insert or ignore is not supported')` when `orIgnore()` was called.
3. Otherwise it emits `INSERT INTO <table> (<columns>) VALUES (...)` and appends `; SELECT SCOPE_IDENTITY() as ID;`.
4. `executeOnDb()` returns `{ RowsAffected, LastInsertId, Returning: [] }`, `LastInsertId` read from the `ID` column. The builder resolves with that object. No mapper is involved.

### Model insert

1. `Model.insert(data)`, `model.insert()`, `model.save()` and the unit of work resolve `ServerResponseMapper` from the connection's container.
2. Nothing is registered under that token on this driver, so the container returns an instance of the base class `ServerResponseMapper` itself.
3. The statement runs; the row is written.
4. The result goes to `ServerResponseMapper.read()`, which throws `MethodNotImplemented('no ServerResponseMapper is registered for this connection. Every driver must register one: ...')`.

### Upsert

1. `InsertBehaviour.InsertOrUpdate` or `insert().onDuplicate(columns).update([...])` sets `QueryContext.Upsert`. Without `columns`, a model query uses its `@Unique` columns.
2. `MsSqlOnDuplicateQueryCompiler.compile()` throws `OrmException('no unique columns defined in table <table>')` when there are no columns. It reads the model's primary key, so it needs a model query.
3. It emits:

```sql
MERGE INTO [shop].[dbo].[customers] WITH (HOLDLOCK) AS target
USING (SELECT * FROM [shop].[dbo].[customers] WHERE Email = ?) as source
ON (target.Id = source.Id)
WHEN MATCHED THEN UPDATE SET [Name] = ?
WHEN NOT MATCHED THEN INSERT ([Email],[Name]) VALUES (?,?); SELECT SCOPE_IDENTITY() as ID;
```

4. `executeOnDb()` returns the `[{ ID }]` row array (the `Upsert` context returns `recordset`).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert response mapper | `ServerResponseMapper` (from `@spinajs/orm`), in the driver's child container; resolved per insert | **none**: the base class, whose `read()` throws | `MysqlServerResponseMapper` (`@spinajs/orm-mysql`) reads the same `{ RowsAffected, LastInsertId }` object but not the upsert row array | Subclass `ServerResponseMapper`, implement `read(data, pkNames?)`, register `.as(ServerResponseMapper)` in a driver subclass's `resolve()` after `super.resolve()`. |
| Insert compiler | `InsertQueryCompiler`, new instance per query | `MsSqlInsertQueryCompiler` (not exported) | `SqlInsertQueryCompiler` (`@spinajs/orm-sql`, MySQL spelling) | Extend `SqlInsertQueryCompiler`, register `.as(InsertQueryCompiler)`. |
| Upsert compiler | `OnDuplicateQueryCompiler`, new instance per query | `MsSqlOnDuplicateQueryCompiler` (not exported) | `SqlOnDuplicateQueryCompiler` (`ON DUPLICATE KEY UPDATE`, not T-SQL) | Extend `SqlOnDuplicateQueryCompiler`; return the `MERGE ... WHEN NOT MATCHED THEN ` prefix. The insert compiler appends `INSERT (...) VALUES (...)` and the identity read. |

### Insert response mapper: custom implementation

`read()` receives what `executeOnDb()` returned: the `{ RowsAffected, LastInsertId, Returning }` object for `Insert`, the `[{ ID }]` rows for `Upsert`. Return a `DbServerResponse`.

```ts sample
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { DbServerResponse, ServerResponseMapper } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

/** Reads the SCOPE_IDENTITY() value the MSSQL insert compiler appends to every insert. */
export class MsSqlServerResponseMapper extends ServerResponseMapper {
  public read(data: any): DbServerResponse {
    if (Array.isArray(data)) {
      // an upsert resolves with the rows of SELECT SCOPE_IDENTITY(); ID is null when MERGE updated
      const id = data.length !== 0 ? data[data.length - 1]?.ID : undefined;
      return { RowsAffected: data.length, LastInsertId: typeof id === 'number' ? id : 0, Returning: [] };
    }

    return {
      RowsAffected: data?.RowsAffected ?? 0,
      LastInsertId: typeof data?.LastInsertId === 'number' ? data.LastInsertId : 0,
      Returning: [],
    };
  }
}

@Injectable('orm-driver-mssql-writable')
@NewInstance()
export class WritableMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(MsSqlServerResponseMapper).as(ServerResponseMapper);
  }
}

// every connection configured with Driver: 'orm-driver-mssql' gets the subclass; call before DI.resolve(Orm)
DI.register(WritableMsSqlDriver).as('orm-driver-mssql');
```

### Upsert compiler: custom implementation

The shipped `MERGE` selects its source from the target table, so when no row matches there is no source row and `WHEN NOT MATCHED` never fires: the upsert of a new row inserts nothing. This compiler builds the source from the inserted values instead, and compares every unique column.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ColumnStatement, InsertQueryBuilder, OnDuplicateQueryCompiler, OrmException, RawQuery, TableAliasCompiler } from '@spinajs/orm';
import { SqlOnDuplicateQueryCompiler } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@NewInstance()
export class ValuesSourceMergeCompiler extends SqlOnDuplicateQueryCompiler {
  public compile() {
    const parent = this._builder.getParent() as InsertQueryBuilder;
    const unique = this._builder.getColumn();

    if (unique.length === 0) {
      throw new OrmException(`no unique columns defined in table ${parent.Table}`);
    }

    const table = parent.Container.resolve(TableAliasCompiler).compile(parent);
    const names = parent.getColumns().map((c) => (c as ColumnStatement).Column as string);
    const valueOf = (column: string) => parent.Values[0][names.indexOf(column)];

    const updates = this._builder.getColumnsToUpdate().map((c: string | RawQuery) => (typeof c === 'string' ? { sql: `${this.Quoter.quote(c)} = ?`, bindings: [valueOf(c)] } : { sql: c.Query, bindings: c.Bindings }));

    return {
      bindings: [...unique.map(valueOf), ...updates.flatMap((u) => u.bindings)],
      expression:
        `MERGE INTO ${table} WITH (HOLDLOCK) AS target ` +
        `USING (SELECT ${unique.map((c) => `? AS ${this.Quoter.quote(c)}`).join(', ')}) AS source ` +
        `ON (${unique.map((c) => `target.${this.Quoter.quote(c)} = source.${this.Quoter.quote(c)}`).join(' AND ')}) ` +
        `WHEN MATCHED THEN UPDATE SET ${updates.map((u) => u.sql).join(', ')} ` +
        `WHEN NOT MATCHED THEN `,
    };
  }
}

@Injectable('orm-driver-mssql-upsert')
@NewInstance()
export class UpsertMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(ValuesSourceMergeCompiler).as(OnDuplicateQueryCompiler);
  }
}
```

## Important behaviour

- **The row is written before the mapper throws.** A model insert without a registered mapper inserts the row, then throws. Inside `driver.transaction()` the throw rolls it back; outside, the row stays and the model has no primary key.
- **`SCOPE_IDENTITY()` is the last identity of the batch.** A multi-row insert reports the last generated key, so `insertIdIsFirstOfBatch` is `false` and the ORM does not backfill keys of a batch.
- **`RETURNING` is not supported.** `insertReturning` is `false`; `InsertQueryBuilder.returning()` throws `NotSupported`.
- **`InsertBehaviour.InsertOrIgnore` throws** `OrmException('mssql insert or ignore is not supported')` at compile time, before anything is sent.
- **`InsertBehaviour.InsertOrReplace` is a plain `INSERT`.** The MSSQL insert compiler ignores `orReplace()`; a duplicate key fails with a SQL Server error.
- **The stock `MERGE` never inserts.** Its source is the existing row matched by the unique columns. A new row produces an empty source, so nothing is inserted; use the compiler above.
- **The stock `MERGE` writes unique column names unquoted** and joins several of them with `,` (`WHERE Email = ?,Tenant = ?`), which is invalid T-SQL. Use one unique column, or the compiler above.
- **The stock `MERGE` needs a model.** It reads the model's primary key; `driver.insert().into('t').onDuplicate('Email')` without a model throws a `TypeError`.
- **`SCOPE_IDENTITY()` is `NULL` after an update.** When `MERGE` updates, the identity row holds `ID: null`, and a mapper reports `LastInsertId: 0`.
- **Large batches are split.** `maxBindParameters` is `2098` and `maxInsertRows` `1000`, so a multi-row insert becomes several statements of at most 1000 rows and 2098 parameters, run in one transaction.

## Best practices

- Register a `ServerResponseMapper` before using models on MSSQL; replace the driver string everywhere with `DI.register(...).as('orm-driver-mssql')` so no connection is left without one.
- Use `InsertBehaviour.InsertOrUpdate` with a single `@Unique` column, or register the upsert compiler above.
- Guard a "create if missing" with `Model.where(...).orderBy(...).first()` or an upsert, not with `InsertOrIgnore`.

## Patterns and antipatterns

```ts
// Don't: InsertOrIgnore throws on SQL Server
await Subscriber.insert(subscriber, InsertBehaviour.InsertOrIgnore);

// Do: upsert on the unique column (with a mapper, and the upsert compiler for new rows)
await Subscriber.insert(subscriber, InsertBehaviour.InsertOrUpdate);
```

## Examples

### Create a customer and read its generated key

With `WritableMsSqlDriver` registered as above:

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mssql')
@Model('customers')
export class Customer extends ModelBase<Customer> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

export async function registerCustomer(email: string, name: string): Promise<number> {
  const customer = new Customer({ Email: email, Name: name });
  await customer.insert();

  // set from SCOPE_IDENTITY() by MsSqlServerResponseMapper
  return customer.Id;
}
```

### Insert a row and read the identity without a mapper

The builder path returns the driver's result directly.

```ts sample
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

export async function logEvent(kind: string, payload: string): Promise<number> {
  const driver = DI.get(Orm)!.Connections.get('mssql')!;
  const result = await driver.insert().into('event_log').values({ Kind: kind, Payload: payload });

  return result.LastInsertId;
}
```

## Related

- [Model API](../orm/03-model-api.md): `insert()`, `save()` and `InsertBehaviour`.
- [Unit of work](../orm/07-unit-of-work.md): how the unit of work reads insert results through the mapper.
- [`SqlDriver`](../orm-sql/01-sql-driver.md#what-executeondb-returns): the result shapes a mapper receives.
- [Query compilers](../orm-sql/02-query-compilers.md): the insert and upsert compiler contracts.
- [Extending the driver](08-extending-the-driver.md): every token this driver registers.
