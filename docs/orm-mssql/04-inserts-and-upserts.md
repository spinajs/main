# Inserts and upserts

On SQL Server an insert is `INSERT INTO ... VALUES (...)` in a batch that selects its own row count, an upsert is a `MERGE` statement, there is no `INSERT OR REPLACE`, and `orIgnore()` is a guarded batch. A one-row insert or upsert of a model whose key the database generates outputs the key columns of its row (`OUTPUT inserted.<key> INTO` a table variable), and `MsSqlServerResponseMapper` reports that key (see [Inserted keys](#inserted-keys)).

## How it works

### Builder insert

1. `driver.insert().into('orders').values({...})` builds an `InsertQueryBuilder` with `QueryContext.Insert`.
2. `MsSqlInsertQueryCompiler.compile()` throws `OrmException('mssql insert or replace is not supported')` when `orReplace()` was called.
3. A one-row insert of a model whose key the database generates compiles to [the keys batch](#the-keys-batch). Any other insert (without a model, several rows, a key the batch cannot hold) emits `INSERT INTO <table> (<columns>) VALUES (...)` and appends `; SELECT SCOPE_IDENTITY() as ID, @@ROWCOUNT as INSERTED;`. `@@ROWCOUNT` is the insert's own count: the counts of an `AFTER` trigger's statements, which `mssql` lists first in `rowsAffected`, do not change it.
4. With `orIgnore()` the insert is wrapped in `BEGIN TRY … END TRY BEGIN CATCH … END CATCH`. The catch swallows errors 2627 (unique constraint) and 2601 (unique index) raised by the insert itself, and rethrows with `THROW` every other error and a duplicate key that a trigger of the table raised. The batch then selects `ID` and `INSERTED`:

```sql
DECLARE @spinajs_inserted INT = 0;
BEGIN TRY INSERT INTO [shop].[dbo].[subscribers] ([Email]) VALUES (?); SET @spinajs_inserted = @@ROWCOUNT; END TRY
BEGIN CATCH IF ERROR_NUMBER() NOT IN (2601, 2627) OR ERROR_PROCEDURE() IS NOT NULL BEGIN; THROW; END; END CATCH;
SELECT CASE WHEN @spinajs_inserted > 0 THEN SCOPE_IDENTITY() END as ID, @spinajs_inserted as INSERTED;
```

5. `executeOnDb()` returns `{ RowsAffected, LastInsertId, Returning: [] }`, `LastInsertId` read from the `ID` column and `RowsAffected` from `INSERTED`, both of the batch's last result set. For an ignored row both are `0`. The keys batch adds `InsertedKeys`. The builder resolves with that object. No mapper is involved.

### The keys batch

A one-row insert of a model is sent as one batch that writes the row's key columns into a table variable and selects them before its own row:

```sql
DECLARE @spinajs_keys TABLE ([Id] sql_variant); DECLARE @spinajs_inserted INT = 0; DECLARE @spinajs_identity NUMERIC(38,0);
IF HAS_PERMS_BY_NAME(N'[shop].[dbo].[orders]', 'OBJECT', 'SELECT', N'Id', 'COLUMN') = 1
  BEGIN INSERT INTO [shop].[dbo].[orders]  ([Customer]) OUTPUT inserted.[Id] INTO @spinajs_keys VALUES (?);
    SELECT @spinajs_inserted = @@ROWCOUNT, @spinajs_identity = SCOPE_IDENTITY(); END
ELSE
  BEGIN INSERT INTO [shop].[dbo].[orders]  ([Customer]) VALUES (@p0);
    SELECT @spinajs_inserted = @@ROWCOUNT, @spinajs_identity = SCOPE_IDENTITY();
    INSERT INTO @spinajs_keys ([Id]) SELECT @spinajs_identity WHERE @spinajs_identity IS NOT NULL; END;
SELECT [Id] FROM @spinajs_keys;
SELECT @spinajs_identity as ID, @spinajs_inserted as INSERTED,
  CASE WHEN DB_NAME() = N'shop' AND OBJECTPROPERTY(OBJECT_ID(N'[shop].[dbo].[orders]'), 'HasInsteadOfTrigger') = 0 THEN 1
       WHEN EXISTS (SELECT 1 FROM @spinajs_keys WHERE [Id] = @spinajs_identity) THEN 1 ELSE 0 END as KEYS_EXACT;
```

- There is one `sql_variant` column, one `inserted.<column>` and one `HAS_PERMS_BY_NAME` per key column, so a composite key comes back whole. A model query carries its database, so the table is qualified with it.
- The statement is in the batch twice and its values are bound once. `executeOnDb()` names the first `n` placeholders of a statement `@p0`..`@p<n-1>` by position ([`toNamedParameters()`](02-executing-statements.md)), which are those of the first form; the compiler writes the second form with those names already in place, through the same rewrite. `OUTPUT inserted.<key>` needs `SELECT` on the key columns: a login with `INSERT` only (`db_datawriter` alone, a column grant without the key) runs the statement without `OUTPUT`, as before, and for a one-column `IDENTITY` key takes `SCOPE_IDENTITY()` as the key. Any other key then stays unknown. A `MERGE` needs `SELECT` on the table in both forms (as before); a login that may read every column but the key takes the second form and gets no key.
- With `orIgnore()` (and no `onDuplicate()`) the `IF` sits in the `TRY` / `CATCH` shown above. An upsert puts `OUTPUT ... INTO @spinajs_keys` after the `MERGE`'s last `WHEN` clause, and takes no key from `SCOPE_IDENTITY()`: after a `MERGE` that updated, it can be the identity of an earlier statement.
- `OUTPUT` goes `INTO` a table variable on every table: SQL Server refuses a bare `OUTPUT` clause on a table with an enabled trigger (error 334), and a trigger can be created after the ORM read the table.
- `sql_variant` holds the exact value of every key type the batch is used for, so the batch needs no declared type; `tableInfo()` keeps no precision. tedious reads a variant as its base type, so a key arrives as a select of the column returns it.
- `OUTPUT` shows the row an `INSTEAD OF` trigger was given, not the row it wrote: an identity key comes back as `0`, a `NEWID()` key as a value the stored row does not have. `KEYS_EXACT` is `1` only when `OBJECTPROPERTY` sees no `INSTEAD OF` trigger on the table or view, or when the key holds the identity this statement generated, which stays `NULL` under such a trigger. `OBJECTPROPERTY` is `NULL`, not `0`, for a login that cannot see the table's metadata (`DENY VIEW DEFINITION`) and for a synonym, so those logins and synonyms keep only an identity key. `executeOnDb()` returns `InsertedKeys`, the result set before the last one, only when `KEYS_EXACT` is `1`.
- `SCOPE_IDENTITY()` is read into `@spinajs_identity` right after the statement: an insert into the table variable resets it to `NULL`.
- An `AFTER` trigger runs after `OUTPUT` and does not change it. Result sets a trigger returns come before the batch's own two.

### Model insert

1. `Model.insert(data)`, `model.insert()`, `model.save()` and the unit of work resolve `ServerResponseMapper` from the connection's container.
2. The driver registers `MsSqlServerResponseMapper` under that token.
3. The statement runs; the row is written.
4. `insertedKeys(result, query)` reports the key of the row, or `undefined` (see [Inserted keys](#inserted-keys)). A model whose key is still empty gets the reported key; without one the key stays empty. A new model leaves a key column with an expression default such as `NEWID()` unset (see [`tableInfo()`](01-configuration.md#important-behaviour)), so the insert sends `DEFAULT` for it.

### Inserted keys

`MsSqlServerResponseMapper.insertedKeys()` decides the keys that `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture take for inserted rows. SQL Server returns no `RETURNING` rows; the source is the `InsertedKeys` of [the keys batch](#the-keys-batch). The mapper reports the key of the row only when all of these hold:

- the insert has a model with a primary key of one or more columns, every key column is one of the model's columns and has a type the batch holds (`tinyint`, `smallint`, `int`, `bigint`, `decimal`, `numeric`, `uniqueidentifier`, `char`, `varchar`, `nchar`, `nvarchar`, the manifest's `uuid` and `string`, or any `IDENTITY` column), and at least one key column has the `auto` strategy;
- the statement writes one row: a plain insert, an `orIgnore()` insert that inserted its row, or an upsert that inserted or updated one row;
- `KEYS_EXACT` is `1`: the table or view is seen to have no `INSTEAD OF` trigger, for any action, or the key holds the identity this plain insert generated;
- the batch output exactly one row, and `read(result).RowsAffected` is `1`;
- every key value is present and exact.

What generates the key does not matter: an `IDENTITY` column, a `NEWID()` / `NEWSEQUENTIALID()` default, a `NEXT VALUE FOR` sequence default, or any other default. For an upsert the key is that of the row the `MERGE` inserted or updated.

A key value is reported as the model holds it after a select:

- a column with a converter gets the value through its `fromDB()`: an `@Int64('string')` key gets a `bigint` past `Number.MAX_SAFE_INTEGER` as its exact text, an `@Int64('bigint')` key as a `bigint`;
- a `bigint` key without a converter, which tedious reads as text, is reported as a number, as `SCOPE_IDENTITY()` reported it before, and only within the safe integer range;
- a number (`int` and the other integer types, `decimal`, `numeric`) must be a safe integer: tedious reads `decimal` and `numeric` as doubles, rounded past 2^53;
- `uniqueidentifier` and character keys are strings, as tedious reads them.

The key is unknown, and the mapper returns `undefined`, for:

| Insert | Why |
| --- | --- |
| Several rows | SQL Server does not promise the `OUTPUT` rows of a multi-row `INSERT ... VALUES` in `VALUES` order (measured: 300 rows into a `NEWID()` table came back in another order), so the batch is not used |
| An `orIgnore()` row that was skipped | the table variable stays empty, `INSERTED` is `0` |
| An upsert whose `ON` condition matched several rows | the `MERGE` updated all of them and output several keys |
| A `bigint` key past `Number.MAX_SAFE_INTEGER` without `@Int64('string')` or `@Int64('bigint')`, a `decimal` key past it, an `@Int64('number')` key past it | the model's key type cannot hold the exact value |
| A table or a view with an `INSTEAD OF` trigger (insert, update or delete; enabled or not) | `OUTPUT` shows the row the trigger was given, not the row it wrote |
| A key that is not an `IDENTITY` (a `NEWID()` or sequence default, an upsert's key), inserted by a login denied `VIEW DEFINITION`, through a synonym, or by a login without `SELECT` on the key | nothing but the catalog tells such a key from one an `INSTEAD OF` trigger replaced, and without `SELECT` there is no `OUTPUT` |
| An insert without a model, a key of another type (`hierarchyid`, `binary`, a date), a key the caller supplies (`uuid` / `assigned` strategy) | the insert compiles without `OUTPUT`; a supplied key is known to the ORM already |

These cases reach [write-capture](../orm/25-write-capture.md) observers as an insert with `unknownKeys: true` and no rows, unless every row supplied its key. An upsert whose row supplies a conflict value is still found by that value.

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

4. The upsert of a model compiles to [the keys batch](#the-keys-batch) with the `OUTPUT` clause after the `MERGE`, and `executeOnDb()` returns the same object as for an insert: `RowsAffected` is the `MERGE`'s own count (`1` for a row inserted or updated), `InsertedKeys` the key of that row. An upsert without a model keeps `; SELECT SCOPE_IDENTITY() as ID;` and `executeOnDb()` returns the `[{ ID }]` rows; `MsSqlServerResponseMapper.read()` reports their count as `RowsAffected` and the last row's `ID` as `LastInsertId`, `0` when it is `NULL`.
5. An upsert takes one row: an upsert of several rows is not supported yet. `MsSqlOnDuplicateQueryCompiler.compile()` throws `NotSupported('mssql upsert takes one row per statement, …')` before any SQL is sent, also when `MaxBindings` / `MaxInsertRows` would split the insert into statements of one row: the `MERGE` matches and inserts a single source row. Upsert one row per call, inside one `transaction()` when the rows belong together:

```ts
await driver.transaction(async () => {
  for (const row of rows) {
    await driver.insert().into('customers').values(row).onDuplicate('Email').update(['Name']);
  }
});
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert response mapper | `ServerResponseMapper` (from `@spinajs/orm`), in the driver's child container; resolved per insert | `MsSqlServerResponseMapper` (exported) | `MysqlServerResponseMapper` (`@spinajs/orm-mysql`) reads the same `{ RowsAffected, LastInsertId }` object but not the upsert row array | Subclass `MsSqlServerResponseMapper` or `ServerResponseMapper`, implement `read(data, pkNames?)` and, to change which keys inserts report, `insertedKeys(response, insert)`; register `.as(ServerResponseMapper)` in a driver subclass's `resolve()` after `super.resolve()`. |
| Insert compiler | `InsertQueryCompiler`, new instance per query | `MsSqlInsertQueryCompiler` (not exported) | `SqlInsertQueryCompiler` (`@spinajs/orm-sql`, MySQL spelling) | Extend `SqlInsertQueryCompiler`, register `.as(InsertQueryCompiler)`. |
| Upsert compiler | `OnDuplicateQueryCompiler`, new instance per query | `MsSqlOnDuplicateQueryCompiler` (not exported) | `SqlOnDuplicateQueryCompiler` (`ON DUPLICATE KEY UPDATE`, not T-SQL) | Extend `SqlOnDuplicateQueryCompiler`; return the `MERGE ... WHEN NOT MATCHED THEN ` prefix. The insert compiler appends `INSERT (...) VALUES (...)` and the `OUTPUT` clause or the identity read. |

### Insert response mapper: custom implementation

`read()` receives what `executeOnDb()` returned: the `{ RowsAffected, LastInsertId, Returning }` object (with `InsertedKeys` from the keys batch) for `Insert` and for the `Upsert` of a model, the `[{ ID }]` rows for an `Upsert` without a model. Return a `DbServerResponse`. `insertedKeys()` calls it for the row count of a model insert that output a key. This one fails such an insert when it wrote no row:

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

Extend `SqlOnDuplicateQueryCompiler` and return the `MERGE ... WHEN NOT MATCHED THEN ` prefix; the insert compiler appends `INSERT (...) VALUES (...)` and the `OUTPUT` clause or the identity read. This one leaves a matched row untouched, so an upsert only inserts missing rows:

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

- **Keys come back for one row.** A multi-row insert compiles without `OUTPUT`, its `LastInsertId` is the last identity of the batch, and the ORM does not backfill keys of a batch.
- **`RETURNING` is not supported.** `insertReturning` is `false`; `InsertQueryBuilder.returning()` throws `NotSupported`.
- **`orIgnore()` takes one row per statement.** A duplicate in a multi-row `VALUES` would refuse every row of it, where the other dialects skip only the duplicate, so several rows with `orIgnore()` throw `OrmException` at compile time.
- **An ignored duplicate leaves the transaction usable.** orm-mssql runs with `XACT_ABORT OFF`: tedious sets it at login, and a `SET XACT_ABORT ON` sent through the driver ends with its own statement. On a connection that does run with `XACT_ABORT ON`, the duplicate dooms the transaction: the insert fails with error 3998 and the transaction is already rolled back.
- **`orIgnore()` with `onDuplicate()` compiles the `MERGE`.** The upsert decides what a conflict does, and `orIgnore()` has no effect.
- **Any unique key counts, and identities are spent.** A duplicate under any unique constraint or index of the table is ignored, not only the one the caller had in mind. A duplicate key that a trigger raises in another table is not ignored: the insert fails. A refused insert still uses up an `IDENTITY` value. A model inserted with `InsertOrIgnore` whose row was ignored keeps an empty key.
- **`InsertBehaviour.InsertOrReplace` throws** `OrmException('mssql insert or replace is not supported')` at compile time. Use `InsertBehaviour.InsertOrUpdate`.
- **An upsert takes one row per statement.** Several rows with `onDuplicate()` throw `NotSupported` before any SQL is sent; a multi-row `MERGE` is not supported yet. Upsert the rows one at a time, in one `transaction()` when they belong together.
- **`MERGE` matches on every unique column**, joined with `AND`, against the inserted values. It works on a builder query without a model: `driver.insert().into('t').values({...}).onDuplicate('Email').update(['Name'])`.
- **`SCOPE_IDENTITY()` after a `MERGE` that updated is not reliable.** On a fresh session it is `NULL`; on a pooled session that inserted before, it can be the identity of that earlier insert, in another table. `LastInsertId` of an upsert is therefore no key; the key of a model upserted with `InsertOrUpdate` comes from `OUTPUT`.
- **Large batches are split.** `MaxBindings` is `2000` and `MaxInsertRows` `1000`, so a multi-row insert becomes several statements of at most 1000 rows and 2000 parameters, run in one transaction.

## Best practices

- Use `InsertBehaviour.InsertOrUpdate` with the model's `@Unique` columns for an upsert.
- Use `InsertBehaviour.InsertOrIgnore` for a "create if missing" of a single row, and check `RowsAffected` to know whether it was created.

## Patterns and antipatterns

```ts
// Don't: several rows with InsertOrIgnore throw on SQL Server
await driver.insert().into('subscribers').values(subscribers).orIgnore();

// Do: one statement per row
for (const subscriber of subscribers) {
  await driver.insert().into('subscribers').values(subscriber).orIgnore();
}
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

  // set from OUTPUT inserted.[Id] by MsSqlServerResponseMapper
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
