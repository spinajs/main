# Inserts and generated keys

MySQL has no `RETURNING`, so `MySqlOrmDriver` hands back generated keys through `LAST_INSERT_ID()`. It is the only shipped driver where a multi-row insert's keys are contiguous from that id, so `Model.insert([...])` can key every row. The insert compiler writes `INSERT IGNORE`, `REPLACE INTO` and `ON DUPLICATE KEY UPDATE`.

## How it works

1. **Build.** `Model.insert()`, `model.insert()`, `model.save()` or `driver.insert().into(table).values(...)` build an `InsertQueryBuilder`. `orIgnore()`, `orReplace()` and `onDuplicate().update(columns)` set its behaviour.
2. **Compile.** `MySqlInsertQueryCompiler` (registered as `InsertQueryCompiler`) extends `SqlInsertQueryCompiler` and overrides `into()`:
   - `orReplace()`: `REPLACE INTO <table>`;
   - `orIgnore()`: `INSERT IGNORE INTO <table>`;
   - otherwise `INSERT INTO <table>`.

   Columns and `VALUES (...), (...)` come from the shared compiler. With `onDuplicate()` and no `orReplace()`, `SqlOnDuplicateQueryCompiler` appends `` ON DUPLICATE KEY UPDATE `col` = VALUES(`col`), ... ``.
3. **Send.** `executeOnDb()` runs it with `QueryContext.Insert` (or `Upsert` after `onDuplicate()`) and resolves `{ RowsAffected, LastInsertId, Returning: [] }` from `mysql2`'s `OkPacket`.
4. **Map.** The model layer resolves `ServerResponseMapper` from the connection container: `MysqlServerResponseMapper.read(data)` returns `{ LastInsertId: data.LastInsertId ?? 0, RowsAffected: data.RowsAffected ?? 0, Returning: [] }`.
5. **Key one row.** For a model with an `auto` primary key and no key set, `PrimaryKeyValue = LastInsertId`.
6. **Key a batch.** For `Model.insert([a, b, c])`, every row gets `LastInsertId + index` when all seven guards hold (next section). Otherwise no key is assigned.

Errors: a duplicate primary or unique key without `orIgnore()`, `orReplace()` or `onDuplicate()` throws `UniqueViolation` ([Errors](01-mysql-driver.md#errors)). `returning(columns)` throws `NotSupported('driver orm-driver-mysql does not support RETURNING on INSERT')`. `Model.insert([...], behaviour)` with any behaviour other than `InsertBehaviour.None` throws `OrmException('insert behaviour is not supported with arrays')`.

### Contiguous keys for a batch

`supportedFeatures()` returns `{ events: true, insertReturning: false, insertIdIsFirstOfBatch: true, maxBindParameters: Infinity, concurrentTransactions: true }`. `maxBindParameters: Infinity` because `mysql2`'s `query()` writes the bindings into the SQL text on the client, so the server never counts parameters; the model layer does not split a MySQL batch by parameter count. The statement is still bounded by the server's `max_allowed_packet`. `insertIdIsFirstOfBatch` rests on InnoDB behaviour:

- `INSERT INTO t (...) VALUES (...), (...)` is a *simple insert*: the row count is known before execution. It is the only shape `InsertQueryBuilder` builds.
- For a simple insert InnoDB reserves one contiguous block of N auto-increment values, and `LAST_INSERT_ID()` reports the first. Row k gets `LAST_INSERT_ID() + k`.
- This holds under `innodb_autoinc_lock_mode = 2`, the MySQL 8 default. The manual's "not contiguous" caveat covers bulk inserts (`INSERT ... SELECT`) and mixed-mode inserts, which the builder does not produce.

`Model.insert([...])` backfills keys only when every guard passes:

1. The driver reports `insertIdIsFirstOfBatch: true` (MySQL only).
2. The model has exactly one primary key column, with `auto` generation.
3. `InsertBehaviour` is `None`: `INSERT IGNORE`, `REPLACE` and `ON DUPLICATE KEY UPDATE` can skip or reuse rows.
4. The batch ran as one statement. A driver subclass that sets `maxBindParameters` or `maxInsertRows` can split it, and the blocks of separate statements are not contiguous.
5. `LastInsertId` is a finite number above `0`.
6. `RowsAffected` equals the number of rows sent.
7. No row carried an explicit key. With some keys supplied, InnoDB allocates values only for the others.

If any guard fails, no key is assigned. Re-select, or insert rows one at a time.

## Configuration

No keys of its own. `innodb_autoinc_lock_mode` is a server variable; the guarantee above holds for `0`, `1` and `2`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert response mapper | `ServerResponseMapper` in the driver's child container; registered in `MySqlOrmDriver.resolve()`; resolved per insert | `MysqlServerResponseMapper` (exported) | | Extend `MysqlServerResponseMapper`, override `read(data, pkColumns?)`, register `.as(ServerResponseMapper)` after `super.resolve()` in a driver subclass. |
| Insert compiler | `InsertQueryCompiler`; `@NewInstance()`, constructor `(container, builder)` | `MySqlInsertQueryCompiler` (not exported) | `SqlInsertQueryCompiler` (no `REPLACE`, `IGNORE`) | Extend `SqlInsertQueryCompiler` from `@spinajs/orm-sql`, override `into()`, register `.as(InsertQueryCompiler)`. |
| Upsert clause compiler | `OnDuplicateQueryCompiler`; constructor `(builder: OnDuplicateQueryBuilder)` | `SqlOnDuplicateQueryCompiler` | | Extend it and override `compile()`, register `.as(OnDuplicateQueryCompiler)`. |
| Feature flags | `supportedFeatures()` on the driver | `{ events: true, insertReturning: false, insertIdIsFirstOfBatch: true, maxBindParameters: Infinity, concurrentTransactions: true }` | | Override in a driver subclass. Set `insertIdIsFirstOfBatch: false` for a server where the guarantee does not hold. |

### Insert response mapper: custom implementation

Replace the mapper when you need the insert response to say more. This one logs inserts whose `RowsAffected` shows `ON DUPLICATE KEY UPDATE` changed an existing row (MySQL counts that row as 2).

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ServerResponseMapper } from '@spinajs/orm';
import { MySqlOrmDriver, MysqlServerResponseMapper } from '@spinajs/orm-mysql';

export class UpsertAwareResponseMapper extends MysqlServerResponseMapper {
  public read(data: any) {
    const response = super.read(data);

    if (response.RowsAffected === 2 && response.LastInsertId > 0) {
      console.info(`upsert updated an existing row (id ${response.LastInsertId})`);
    }

    return response;
  }
}

@Injectable('orm-driver-mysql')
@NewInstance()
export class UpsertAwareMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UpsertAwareResponseMapper).as(ServerResponseMapper);
  }
}
```

### Insert compiler: custom implementation

`MySqlInsertQueryCompiler` is not exported, so extend the shared `SqlInsertQueryCompiler` and write the MySQL `into()` yourself. This one adds `HIGH_PRIORITY` to inserts on a reporting connection whose `MyISAM` tables are read constantly, so writes do not wait behind queued reads.

```ts sample
import { Container, IContainer, Inject, Injectable, NewInstance } from '@spinajs/di';
import { InsertQueryBuilder, InsertQueryCompiler, TableAliasCompiler } from '@spinajs/orm';
import { SqlInsertQueryCompiler } from '@spinajs/orm-sql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';

@NewInstance()
@Inject(Container)
export class HighPriorityInsertCompiler extends SqlInsertQueryCompiler {
  constructor(container: IContainer, builder: InsertQueryBuilder) {
    super(container, builder);
  }

  protected into() {
    const table = this._container.resolve(TableAliasCompiler).compile(this._builder);

    // REPLACE accepts no HIGH_PRIORITY modifier
    if (this._builder.Replace) {
      return `REPLACE INTO ${table}`;
    }

    return `INSERT HIGH_PRIORITY${this._builder.Ignore ? ' IGNORE' : ''} INTO ${table}`;
  }
}

@Injectable('orm-driver-mysql-reporting')
@NewInstance()
export class ReportingMySqlDriver extends MySqlOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(HighPriorityInsertCompiler).as(InsertQueryCompiler);
  }
}
```

## Important behaviour

- `returning()` throws instead of doing nothing. Read keys from `LastInsertId`, which the model layer does for you.
- `LastInsertId` is `0` for a `uuid` or `assigned` key. Check `RowsAffected` to know an insert succeeded.
- `onDuplicate(column)` ignores `column` on MySQL: `ON DUPLICATE KEY UPDATE` fires on a conflict with **any** primary or unique key.
- `VALUES(col)` in the update list is deprecated since MySQL 8.0.20 and logs a warning; it still works.
- `orReplace()` wins over `onDuplicate()`: with both, the statement is `REPLACE INTO` with no update clause. `REPLACE` deletes the old row and inserts a new one, so it fires delete triggers and cascades foreign keys.
- `orIgnore()` turns errors such as a duplicate key into warnings; the row is skipped and `RowsAffected` is lower.
- The unit of work (`save()`) inserts one statement per row, so it does not depend on contiguous keys.
- <!-- TODO(docs-hook): verify which LastInsertId model.insert(InsertBehaviour.InsertOrUpdate) reports when the row already existed and was updated -->

## Best practices

- Insert batches through `Model.insert([...])` with no keys set; every row gets its key from one statement.
- Use `InsertBehaviour.InsertOrUpdate` on a single model, not on an array; arrays reject any behaviour.
- Keep `innodb_autoinc_lock_mode` at a documented value and confirm it on MariaDB before relying on batch keys.

## Patterns and antipatterns

```ts
// Don't: throws NotSupported on MySQL
await driver.insert().into('invoices').values({ Number: 'FV/1/2026' }).returning(['Id']);

// Do: read the generated key from the response
const result = await driver.insert().into('invoices').values({ Number: 'FV/1/2026' });
const id = result.LastInsertId;
```

```ts
// Don't: a batch where some rows carry keys; none of the generated keys are assigned
await Invoice.insert([new Invoice({ Id: 500, Number: 'A' }), new Invoice({ Number: 'B' })]);

// Do: let the database key all of them, or insert the keyed row on its own
await Invoice.insert([new Invoice({ Number: 'A' }), new Invoice({ Number: 'B' })]);
```

## Examples

### Import a day's invoices and keep their generated ids

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('shop')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Number: string;

  public Total: string;
}

export async function importInvoices(numbers: string[]): Promise<number[]> {
  const invoices = numbers.map((n) => new Invoice({ Number: n, Total: '0.00' }));

  // one INSERT ... VALUES (...), (...) statement; ids are LAST_INSERT_ID() + index
  await Invoice.insert(invoices);

  return invoices.map((i) => i.Id);
}
```

### Count page views with an upsert

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver, RawQuery } from '@spinajs/orm';

export async function countView(path: string, day: string) {
  const stats = DI.resolve<OrmDriver>('OrmConnection', ['shop'])!;

  // INSERT INTO `page_views` (...) VALUES (?,?,?) ON DUPLICATE KEY UPDATE Views = Views + 1
  await stats
    .insert()
    .into('page_views')
    .values({ Path: path, Day: day, Views: 1 })
    .onDuplicate()
    .update([RawQuery.create('`Views` = `Views` + 1')]);
}
```

## Related

- [Query builder](../orm/05-query-builder.md#insert-update-and-delete): `orIgnore()`, `orReplace()`, `onDuplicate()`.
- [Model API](../orm/03-model-api.md): `Model.insert()`, `InsertBehaviour`.
- [Unit of work](../orm/07-unit-of-work.md): why `save()` inserts row by row.
- [Query compilers](../orm-sql/02-query-compilers.md): `SqlInsertQueryCompiler` and its hooks.
