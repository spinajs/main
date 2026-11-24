# Inserts and generated keys

MySQL has no `RETURNING`, so `MySqlOrmDriver` reads the keys of inserted rows off the OK packet's `insertId` (`LAST_INSERT_ID()`). `MysqlServerResponseMapper.insertedKeys()` owns that rule: one row gets `insertId`, and the rows of one plain multi-row insert get the block that starts there, advancing by the connection's `auto_increment_increment`. Where the packet does not prove a key, it reports none. The insert compiler writes `INSERT IGNORE`, `REPLACE INTO` and `ON DUPLICATE KEY UPDATE`.

## How it works

1. **Build.** `Model.insert()`, `model.insert()`, `model.save()` or `driver.insert().into(table).values(...)` build an `InsertQueryBuilder`. `orIgnore()`, `orReplace()` and `onDuplicate().update(columns)` set its behaviour.
2. **Compile.** `MySqlInsertQueryCompiler` (registered as `InsertQueryCompiler`) extends `SqlInsertQueryCompiler` and overrides `into()`:
   - `orReplace()`: `REPLACE INTO <table>`;
   - `orIgnore()`: `INSERT IGNORE INTO <table>`;
   - otherwise `INSERT INTO <table>`.

   Columns and `VALUES (...), (...)` come from the shared compiler. With `onDuplicate()` and no `orReplace()`, `SqlOnDuplicateQueryCompiler` appends `` ON DUPLICATE KEY UPDATE `col` = VALUES(`col`), ... ``.
3. **Send.** `executeOnDb()` runs it with `QueryContext.Insert` (or `Upsert` after `onDuplicate()`) and resolves `{ RowsAffected, LastInsertId, Returning: [], AutoIncrementStep }`: the first two from `mysql2`'s `OkPacket`, the last the step the connection last reported ([The step of a connection](#the-step-of-a-connection)).
4. **Map.** The model layer resolves `ServerResponseMapper` from the connection container: `MysqlServerResponseMapper.read(data)` returns `{ LastInsertId: data.LastInsertId ?? 0, RowsAffected: data.RowsAffected ?? 0, Returning: [] }`.
5. **Key the rows.** `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture take keys from `MysqlServerResponseMapper.insertedKeys(response, insert)`: one key per row, or none at all (next section). A key the row already holds is never overwritten.

Errors: a duplicate primary or unique key without `orIgnore()`, `orReplace()` or `onDuplicate()` throws `UniqueViolation` ([Errors](01-mysql-driver.md#errors)). `returning(columns)` throws `NotSupported('driver orm-driver-mysql does not support RETURNING on INSERT')`. `Model.insert([...], behaviour)` with any behaviour other than `InsertBehaviour.None` throws `OrmException('insert behaviour is not supported with arrays')`.

### Which keys an insert reports

A key is reported only for a model with a single-column primary key whose generation is `auto` and whose column is `AUTO_INCREMENT` (`AutoIncrement` in the table info, read from `EXTRA`), and only when `insertId` is a positive safe integer. An insert without a model, a composite key, a `uuid` or `assigned` key, or a key column without `AUTO_INCREMENT` reports none.

**One row.** The key is `insertId` when the packet proves that the statement wrote that row. Measured on MySQL 8.4.11 with `mysql2` 3.22, whose default flags include `FOUND_ROWS`:

| Statement | Outcome | `affectedRows` | `insertId` | Reported key |
| --- | --- | --- | --- | --- |
| `INSERT` | inserted | 1 | the new id, or the explicit one | `insertId` |
| `INSERT IGNORE` | inserted | 1 | the new id | `insertId` |
| `INSERT IGNORE` | skipped (duplicate) | 0 | 0 | none |
| `REPLACE` | inserted, no conflict | 1 | the new id | `insertId` |
| `REPLACE` | deleted the conflicting row, inserted a new one | 1 + the rows deleted | the new row's id, or the explicit one | `insertId` |
| `ON DUPLICATE KEY UPDATE` | inserted | 1 | the new id | `insertId` |
| `ON DUPLICATE KEY UPDATE` | updated an existing row | 2 | the updated row's id | `insertId` |
| `ON DUPLICATE KEY UPDATE` | row left unchanged | 1 with `FOUND_ROWS`, 0 without | 0 | none |
| `INSERT IGNORE ... ON DUPLICATE KEY UPDATE` | any | not measured | | none |

Without `FOUND_ROWS` the other rows are the same. An upsert that updated a row is keyed because MySQL reports that row's id (`mysql_insert_id()`: "the last of the inserted or updated values"), so `model.insert(InsertBehaviour.InsertOrUpdate)` on a model without a key gets the key of the row it updated.

**Several rows.** A plain `INSERT INTO t (...) VALUES (...), (...)` is a *simple insert* to InnoDB: its row count is known before it runs, so InnoDB reserves one block for it and `insertId` is the first value of that block, under every `innodb_autoinc_lock_mode` (the MySQL 8 default is `2`). The block advances by `auto_increment_increment`: row k gets `insertId + k * auto_increment_increment`. With step 3 and `auto_increment_offset = 2`, three rows got `2, 5, 8`. In a run of 360 concurrent statements with steps 1 and 2, and `INSERT ... SELECT` bulk inserts running alongside, every block matched this walk. The keys are reported only when all of these hold:

1. The connection's step is known ([The step of a connection](#the-step-of-a-connection)).
2. No `orIgnore()`, `orReplace()` or `onDuplicate()`: a skipped, replaced or updated row breaks the block.
3. `affectedRows` equals the number of rows sent.
4. No row carried an explicit key. With some keys supplied, InnoDB allocates values only for the others.
5. The batch ran as one statement. A batch over `MaxBindings` (`65535` parameters) or `MaxInsertRows` is split, and separate statements get separate blocks.
6. The last key of the walk is a safe integer.

If any of them fails, no row gets a key. Re-select, or insert rows one at a time. The rule does not read the driver's `insertIdIsFirstOfBatch` flag.

### The step of a connection

`auto_increment_increment` is a session variable; multi-primary and Galera setups set it above 1. The driver learns it without a query per insert:

- When `mysql2` opens a pooled connection, the driver adds `auto_increment_increment` to `session_track_system_variables` and sets the step to itself in the same `SET`, so the server reports the value in that statement's OK packet.
- From then on the server reports every change the session makes (`SET SESSION auto_increment_increment = 3`, `SET @@session.auto_increment_increment = 3`, a `SET` inside a procedure) in the OK packet of the statement that made it, and the driver keeps the connection's step current from it.
- Each insert response carries the step of the connection it ran on as `AutoIncrementStep`.

The step is unknown, and a multi-row insert reports no keys, when the server has no session tracking (MySQL before 5.7, MariaDB before 10.2), when `Options.flags` drops `SESSION_TRACK`, when that `SET` fails, and on connections outside the pool (`openDedicatedConnection()`). A single row needs no step.

## Configuration

No keys of its own. `MaxBindings` is `65535`, the server's prepared-statement limit; `mysql2`'s `query()` writes the bindings into the SQL text on the client, so a batch is bounded in practice by the server's `max_allowed_packet`. Multi-row keys need the `SESSION_TRACK` flag, which is among `mysql2`'s defaults.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert response mapper | `ServerResponseMapper` in the driver's child container; registered in `MySqlOrmDriver.resolve()`; resolved per insert | `MysqlServerResponseMapper` (exported) | | Extend `MysqlServerResponseMapper`, override `read(data, pkColumns?)` or `insertedKeys(response, insert)`, register `.as(ServerResponseMapper)` after `super.resolve()` in a driver subclass. |
| Insert compiler | `InsertQueryCompiler`; `@NewInstance()`, constructor `(container, builder)` | `MySqlInsertQueryCompiler` | `SqlInsertQueryCompiler` (no `REPLACE`, `IGNORE`) | Extend `SqlInsertQueryCompiler` from `@spinajs/orm-sql`, override `into()`, register `.as(InsertQueryCompiler)`. |
| Upsert clause compiler | `OnDuplicateQueryCompiler`; constructor `(builder: OnDuplicateQueryBuilder)` | `SqlOnDuplicateQueryCompiler` | | Extend it and override `compile()`, register `.as(OnDuplicateQueryCompiler)`. |
| Feature flags | `supportedFeatures()` on the driver | `{ events: true, insertReturning: false, insertIdIsFirstOfBatch: true, nativeJson: true, concurrentTransactions: true, streaming: true }` | | Override in a driver subclass. The keys of inserted rows do not depend on `insertIdIsFirstOfBatch`. |

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

Extend `MySqlInsertQueryCompiler`, or the shared `SqlInsertQueryCompiler` as here when you write the whole `into()` yourself. This one adds `HIGH_PRIORITY` to inserts on a reporting connection whose `MyISAM` tables are read constantly, so writes do not wait behind queued reads.

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
- `model.insert(InsertBehaviour.InsertOrUpdate)` on a row that already existed reports that row's id as `LastInsertId`, and the model gets it as its key. When the update changed nothing, `LastInsertId` is `0` and the model gets no key.

## Best practices

- Insert batches through `Model.insert([...])` with no keys set; every row gets its key from one statement.
- Use `InsertBehaviour.InsertOrUpdate` on a single model, not on an array; arrays reject any behaviour.
- Set a session `auto_increment_increment` inside the transaction that inserts: outside one, `SET SESSION` lands on whichever pooled connection runs it and stays there. The keys are right either way; the ids are not the ones you meant.

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

  // one INSERT ... VALUES (...), (...) statement; ids are LAST_INSERT_ID() + index * auto_increment_increment
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
