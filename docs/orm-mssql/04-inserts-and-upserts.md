# Inserts and upserts

On SQL Server an insert is `INSERT INTO ... VALUES (...); SELECT SCOPE_IDENTITY() as ID;`, an upsert is a `MERGE` statement, and neither `INSERT IGNORE` nor `INSERT OR REPLACE` exists. `MsSqlServerResponseMapper` reads the generated key back for model inserts.

## How it works

### Builder insert

1. `driver.insert().into('orders').values({...})` builds an `InsertQueryBuilder` with `QueryContext.Insert`.
2. `MsSqlInsertQueryCompiler.compile()` throws `OrmException('mssql insert or ignore is not supported')` when `orIgnore()` was called, and `OrmException('mssql insert or replace is not supported')` when `orReplace()` was called.
3. Otherwise it emits `INSERT INTO <table> (<columns>) VALUES (...)` and appends `; SELECT SCOPE_IDENTITY() as ID;`.
4. `executeOnDb()` returns `{ RowsAffected, LastInsertId, Returning: [] }`, `LastInsertId` read from the `ID` column. The builder resolves with that object. No mapper is involved.

### Model insert

1. `Model.insert(data)`, `model.insert()`, `model.save()` and the unit of work resolve `ServerResponseMapper` from the connection's container.
2. The driver registers `MsSqlServerResponseMapper` under that token.
3. The statement runs; the row is written.
4. `read()` turns the `executeOnDb()` result into a `DbServerResponse`: `LastInsertId` is the `SCOPE_IDENTITY()` value, `0` when it is not a number. The model's primary key is set from it.

### Upsert

1. `InsertBehaviour.InsertOrUpdate` or `insert().onDuplicate(columns).update([...])` sets `QueryContext.Upsert`. Without `columns`, a model query uses its `@Unique` columns.
2. `MsSqlOnDuplicateQueryCompiler.compile()` throws `OrmException('no unique columns defined in table <table>')` when there are no columns.
3. It builds the source from the inserted values of the unique columns and matches on all of them:

```sql
MERGE INTO [shop].[dbo].[customers] WITH (HOLDLOCK) AS target
USING (SELECT ? AS [Email]) AS source
ON (target.[Email] = source.[Email])
WHEN MATCHED THEN UPDATE SET [Name] = ?
WHEN NOT MATCHED THEN INSERT ([Email],[Name]) VALUES (?,?); SELECT SCOPE_IDENTITY() as ID;
```

4. `executeOnDb()` returns the `[{ ID }]` row array (the `Upsert` context returns `recordset`). For a model upsert `MsSqlServerResponseMapper` reports the row count as `RowsAffected` and the last row's `ID` as `LastInsertId`, `0` when `MERGE` updated.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert response mapper | `ServerResponseMapper` (from `@spinajs/orm`), in the driver's child container; resolved per insert | `MsSqlServerResponseMapper` (exported) | `MysqlServerResponseMapper` (`@spinajs/orm-mysql`) reads the same `{ RowsAffected, LastInsertId }` object but not the upsert row array | Subclass `MsSqlServerResponseMapper` or `ServerResponseMapper`, implement `read(data, pkNames?)`, register `.as(ServerResponseMapper)` in a driver subclass's `resolve()` after `super.resolve()`. |
| Insert compiler | `InsertQueryCompiler`, new instance per query | `MsSqlInsertQueryCompiler` (not exported) | `SqlInsertQueryCompiler` (`@spinajs/orm-sql`, MySQL spelling) | Extend `SqlInsertQueryCompiler`, register `.as(InsertQueryCompiler)`. |
| Upsert compiler | `OnDuplicateQueryCompiler`, new instance per query | `MsSqlOnDuplicateQueryCompiler` (not exported) | `SqlOnDuplicateQueryCompiler` (`ON DUPLICATE KEY UPDATE`, not T-SQL) | Extend `SqlOnDuplicateQueryCompiler`; return the `MERGE ... WHEN NOT MATCHED THEN ` prefix. The insert compiler appends `INSERT (...) VALUES (...)` and the identity read. |

### Insert response mapper: custom implementation

`read()` receives what `executeOnDb()` returned: the `{ RowsAffected, LastInsertId, Returning }` object for `Insert`, the `[{ ID }]` rows for `Upsert`. Return a `DbServerResponse`. This one fails an insert that wrote no row:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DbServerResponse, OrmException, ServerResponseMapper } from '@spinajs/orm';
import { MsSqlOrmDriver, MsSqlServerResponseMapper } from '@spinajs/orm-mssql';

/** Throws instead of leaving the model without a key when a plain insert wrote nothing. */
export class StrictResponseMapper extends MsSqlServerResponseMapper {
  public read(data: any): DbServerResponse {
    const response = super.read(data);

    if (!Array.isArray(data) && response.RowsAffected === 0) {
      throw new OrmException('insert wrote no row');
    }

    return response;
  }
}

@Injectable('orm-driver-mssql-strict')
@NewInstance()
export class StrictMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(StrictResponseMapper).as(ServerResponseMapper);
  }
}
```

### Upsert compiler: custom implementation

Extend `SqlOnDuplicateQueryCompiler` and return the `MERGE ... WHEN NOT MATCHED THEN ` prefix; the insert compiler appends `INSERT (...) VALUES (...)` and the identity read. This one leaves a matched row untouched, so an upsert only inserts missing rows:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ColumnStatement, InsertQueryBuilder, OnDuplicateQueryCompiler, OrmException, TableAliasCompiler } from '@spinajs/orm';
import { SqlOnDuplicateQueryCompiler } from '@spinajs/orm-sql';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';

@NewInstance()
export class InsertMissingMergeCompiler extends SqlOnDuplicateQueryCompiler {
  public compile() {
    const parent = this._builder.getParent() as InsertQueryBuilder;
    const unique = this._builder.getColumn();

    if (unique.length === 0) {
      throw new OrmException(`no unique columns defined in table ${parent.Table}`);
    }

    const table = parent.Container.resolve(TableAliasCompiler).compile(parent);
    const names = parent.getColumns().map((c) => (c as ColumnStatement).Column as string);
    const valueOf = (column: string) => parent.Values[0][names.indexOf(column)];

    return {
      bindings: unique.map(valueOf),
      expression:
        `MERGE INTO ${table} WITH (HOLDLOCK) AS target ` +
        `USING (SELECT ${unique.map((c) => `? AS ${this.Quoter.quote(c)}`).join(', ')}) AS source ` +
        `ON (${unique.map((c) => `target.${this.Quoter.quote(c)} = source.${this.Quoter.quote(c)}`).join(' AND ')}) ` +
        `WHEN NOT MATCHED THEN `,
    };
  }
}

@Injectable('orm-driver-mssql-insert-missing')
@NewInstance()
export class InsertMissingMsSqlDriver extends MsSqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(InsertMissingMergeCompiler).as(OnDuplicateQueryCompiler);
  }
}
```

## Important behaviour

- **`SCOPE_IDENTITY()` is the last identity of the batch.** A multi-row insert reports the last generated key, so `insertIdIsFirstOfBatch` is `false` and the ORM does not backfill keys of a batch.
- **`RETURNING` is not supported.** `insertReturning` is `false`; `InsertQueryBuilder.returning()` throws `NotSupported`.
- **`InsertBehaviour.InsertOrIgnore` throws** `OrmException('mssql insert or ignore is not supported')` at compile time, before anything is sent.
- **`InsertBehaviour.InsertOrReplace` throws** `OrmException('mssql insert or replace is not supported')` at compile time. Use `InsertBehaviour.InsertOrUpdate`.
- **`MERGE` matches on every unique column**, joined with `AND`, against the inserted values. It works on a builder query without a model: `driver.insert().into('t').values({...}).onDuplicate('Email').update(['Name'])`.
- **`SCOPE_IDENTITY()` is `NULL` after an update.** When `MERGE` updates, the identity row holds `ID: null`, and `MsSqlServerResponseMapper` reports `LastInsertId: 0`.
- **Large batches are split.** `MaxBindings` is `2000` and `MaxInsertRows` `1000`, so a multi-row insert becomes several statements of at most 1000 rows and 2000 parameters, run in one transaction.

## Best practices

- Use `InsertBehaviour.InsertOrUpdate` with the model's `@Unique` columns for an upsert.
- Guard a "create if missing" with `Model.where(...).orderBy(...).first()` or an upsert, not with `InsertOrIgnore`.

## Patterns and antipatterns

```ts
// Don't: InsertOrIgnore throws on SQL Server
await Subscriber.insert(subscriber, InsertBehaviour.InsertOrIgnore);

// Do: upsert on the unique column
await Subscriber.insert(subscriber, InsertBehaviour.InsertOrUpdate);
```

## Examples

### Create a customer and read its generated key

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

### Insert a row and read the identity from a builder

The builder path returns the driver's result directly, without the mapper.

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
