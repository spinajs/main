# Inserts, upserts and `RETURNING`

SQLite is the driver with `RETURNING` (`insertReturning: true`), so it reads generated keys back exactly, also from multi-row inserts. An insert that came back without `RETURNING` rows reports a key only for one row written through the rowid alias. This page covers how SQLite spells `INSERT`, `INSERT OR IGNORE` / `OR REPLACE`, `ON CONFLICT ... DO UPDATE` and `RETURNING`, how the raw result becomes a `DbServerResponse`, and how a model becomes an insert row.

## How it works

1. **Build.** `driver.insert().into(table).values(rowOrRows)`, or a model insert, builds an `InsertQueryBuilder` with `QueryContext.Insert`.
   - `.orIgnore()` sets `Ignore`; `.orReplace()` sets `Replace`.
   - `.returning(columns)` sets `Returning` and switches to `QueryContext.InsertReturning`. It throws `NotSupported` on drivers without `insertReturning`; SQLite has it.
   - `.onDuplicate(columns?)` switches to `QueryContext.Upsert` and returns an `OnDuplicateQueryBuilder`. Without `columns`, the conflict target is the model's columns flagged `Unique`. `.update(columns)` names the columns to overwrite.
2. **Compile.** `toDB()` resolves `InsertQueryCompiler`: `SqliteInsertQueryCompiler.compile()` joins `into()`, `columns()`, `values()`, `upsort()` and `returning()`:
   - `into()`: ``INSERT [OR IGNORE] [OR REPLACE] INTO `table` ``.
   - `columns()` / `values()`: an auto-increment primary key is left out when no row supplies it, else rendered `NULL` in the rows that do not; `null` renders `NULL`. SQLite has no `DEFAULT` inside `VALUES`, so `undefined` is handled per column:
     - no row supplies the column: it is left out, and the table default applies;
     - some rows supply it: the others render `NULL` when the column is known (model inserts) to be nullable without a default; otherwise compiling throws `InvalidArgument('insert into <t>: a row has no value for column <c> ...')`.
   - `upsort()`: when `onDuplicate()` was called and `orReplace()` was not, resolves `OnDuplicateQueryCompiler`: `SqliteOnDuplicateQueryCompiler`, which emits ``ON CONFLICT(`target`) DO UPDATE SET `col` = excluded.`col`, ... RETURNING <cols|*>;``. `excluded.col` is the row being inserted, so each conflicting row of a multi-row upsert gets its own values. Without `update()` it emits `DO NOTHING`. A `RawQuery` in `update()` is copied as is, with its bindings.
   - `returning()`: ``RETURNING `a`,`b` `` (or `*`), skipped when an upsert clause is present, because `ON CONFLICT` already carries one.
3. **Split.** `driver.MaxBindings` is `32766`, SQLite's `SQLITE_MAX_VARIABLE_NUMBER` in the build `sqlite3` 5.x bundles. A multi-row insert that would bind more values is sent as several statements, each under the limit. They are atomic: when a later statement fails, the rows of the earlier ones are rolled back too.
4. **Execute.** `executeOnDb()` uses `run()` for `Insert` and `all()` for `InsertReturning` and `Upsert` (see [Result shapes](01-connection.md#result-shapes)).
5. **Map.** Model inserts resolve `ServerResponseMapper` (`SqliteServerResponseMapper`) and call `read(result, pkNames)`:
   - An array (upsert rows): `RowsAffected` = row count; `LastInsertId` = the key of the **last** row when there is one key column and its value is a number, else `0`; `Returning` = the rows.
   - An object: `RowsAffected`, `LastInsertId` and `Returning` copied, defaulting to `0`, `0`, `[]`.
6. **Keys back.** A model with an `auto` key asks for `RETURNING <key columns>` (`model.insert()` except with `InsertOrUpdate`, and `Model.insert(rowOrRows)`). `ModelBase.insert()`, the static `Model.insert()`, the unit of work and the write capture take keys from `SqliteServerResponseMapper.insertedKeys(response, insert)`: one key per row, or none at all (next section). When `Returning` has one row per inserted model, each model gets its own key, in insert order, also when the insert was split into several statements. `uuid` and `assigned` keys are set before the insert and kept; a key the row already holds is never overwritten.

### Which keys an insert reports

`insertedKeys()` first takes the keys of the `RETURNING` rows, when there is one row with the whole key per inserted row. Every model insert of an `auto` key and every upsert (`ON CONFLICT` always compiles `RETURNING`) gets its keys this way.

An insert that came back without them, such as a builder made with `createQuery(Model, InsertQueryBuilder)` or a `driver.insert()` without `returning()`, gets SQLite's rowid rule: the key is `sqlite3`'s `lastID` (`sqlite3_last_insert_rowid()`) only when all of these hold:

1. The insert has a model whose primary key is one column, generated `auto`, and flagged `AutoIncrement` by the table info: a lone `INTEGER PRIMARY KEY`, the rowid alias.
2. It inserts one row, without `onDuplicate()`.
3. `RowsAffected` (`changes`) is 1. `lastID` keeps the rowid of an earlier insert on the connection when this statement inserted nothing.
4. `lastID` is a positive safe integer.
5. The row supplies no key and the key column has no default, or the row supplies the number `lastID` holds. In a `WITHOUT ROWID` table, which the table info does not tell apart, an `INTEGER PRIMARY KEY` is not the rowid, so a row there either supplies its key or takes the column default, and `lastID` is stale.

Otherwise the insert reports no keys: several rows (`lastID` names only the last), a composite, `uuid`, `assigned` or text key (a text or `BLOB` key the database fills has a rowid that is not the key), or an insert without a model. Such an insert reaches write observers with `unknownKeys: true`.

Measured with `sqlite3` 5.x (SQLite 3.44.2) on a table `t (Id INTEGER PRIMARY KEY, Email TEXT UNIQUE, Name TEXT)` unless the row says otherwise:

| Statement | Outcome | `changes` | `lastID` | Reported key |
| --- | --- | --- | --- | --- |
| `INSERT` | inserted | 1 | the new rowid, or the supplied key | `lastID` |
| `INSERT OR IGNORE` | inserted | 1 | the new rowid | `lastID` |
| `INSERT OR IGNORE` | skipped (`UNIQUE` or `CHECK`) | 0 | the earlier insert's rowid | none |
| `INSERT OR REPLACE` | deleted the conflicting row (one or two of them), inserted a new one | 1 | the new row's rowid | `lastID` |
| `INSERT OR REPLACE` | inserted, no conflict | 1 | the new rowid | `lastID` |
| `INSERT ... ON CONFLICT DO UPDATE` without `RETURNING` | updated | 1 | the earlier insert's rowid | none (has `RETURNING` when compiled) |
| `INSERT ... ON CONFLICT DO NOTHING` | skipped | 0 | the earlier insert's rowid | none |
| `INSERT` with two rows | inserted | 2 | the last rowid | none |
| `INSERT` into a table whose `BEFORE` or `AFTER INSERT` trigger inserts into another table | inserted | 1 | this statement's row, not the trigger's | `lastID` |
| `INSERT` stopped by a `BEFORE INSERT` trigger's `RAISE(IGNORE)` | skipped | 0 | the earlier insert's rowid | none |
| `INSERT` into a view with an `INSTEAD OF` trigger | inserted into the base table | 0 | the earlier insert's rowid | none |
| `INSERT` into `WITHOUT ROWID` with `Id INTEGER PRIMARY KEY` supplied | inserted | 1 | the earlier insert's rowid | none, unless equal to the supplied key |
| `INSERT` into `WITHOUT ROWID` with a key the column `DEFAULT` fills | inserted | 1 | the earlier insert's rowid | none |
| `INSERT` into `Id TEXT PRIMARY KEY DEFAULT (...)` | inserted | 1 | the hidden rowid | none |
| `INSERT` with a supplied key past `2^53` | inserted | 1 | rounded | none |

### Model serialization

`model.toSql()` resolves `ModelToSqlConverter` from the driver container: `SqliteModelToSqlConverter`. Per column of the model descriptor:

1. Skips `Virtual` columns and foreign-key columns that a relation manages.
2. Throws `OrmException('Field <col> cannot be null')` for a non-key, non-nullable column holding `null`, `undefined` or `''`.
3. Leaves out columns whose value is `undefined`, so the table default applies. SQLite does not accept `DEFAULT` inside `VALUES`.
4. Writes the rest through the column's converter (`toDB`), if any.

Then per `belongsTo` relation it writes the foreign key: the related model's join column when the relation holds a value, else the raw foreign-key property when set, else `NULL` after a detach (`attach(null)`). A recursive relation always copies the raw foreign-key property. Both go through the foreign-key column's converter, as step 4 does; the base class `ModelToSqlConverter` does this in its protected `relationForeignKeys(model)`, so a subclass that overrides `toSql()` calls it for the relation keys.

The only difference from `StandardModelToSqlConverter` in `@spinajs/orm` is step 3: the standard converter keeps `undefined` values.

## Configuration

No keys. `supportedFeatures()` is fixed: `{ events: false, insertReturning: true, nativeJson: false, concurrentTransactions: false, streaming }` (`streaming` is `true` with a read pool on a WAL file), and `MaxBindings` is `32766`. `MaxBindings` sets where a multi-row insert is split. `concurrentTransactions: false` makes the core queue outermost transactions (see [Transactions](03-transactions.md)).

## Services and extension points

All registered by `SqliteOrmDriver.resolve()` in the connection's child container.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert compiler | `InsertQueryCompiler`, new instance, constructor `(container, builder)` | `SqliteInsertQueryCompiler` (exported) | `SqlInsertQueryCompiler` from `@spinajs/orm-sql` (no `RETURNING`, MySQL `IGNORE`) | Subclass; override `compile()`, `into()`, `returning()`, `upsort()`, `values()`, `columns()`, `autoIncrementPlaceholder()`. |
| Upsert compiler | `OnDuplicateQueryCompiler`, new instance, constructor `(builder: OnDuplicateQueryBuilder)` | `SqliteOnDuplicateQueryCompiler` (exported) | `SqlOnDuplicateQueryCompiler` (MySQL `ON DUPLICATE KEY UPDATE`) | Subclass; override `compile()`. |
| Insert response | `ServerResponseMapper`, new instance | `SqliteServerResponseMapper` (exported) | none; the base class throws `MethodNotImplemented` | Subclass `SqliteServerResponseMapper`; override `read(data, pkNames?)`, or `insertedKeys(response, insert)` for the keys of inserted rows. |
| Model to row | `ModelToSqlConverter`, new instance | `SqliteModelToSqlConverter` (exported) | `StandardModelToSqlConverter` from `@spinajs/orm` | Subclass `SqliteModelToSqlConverter`; override `toSql(model)`. |
| Plain object to row | `ObjectToSqlConverter`, new instance, registered by `OrmDriver.resolve()` | `StandardObjectToSqlConverter` | | Used by `Model.insert()` with plain objects; it already leaves out `undefined`. |

### Upsert compiler: custom implementation

Keep the newer of two timestamps on conflict instead of overwriting it, by adding a `WHERE` to the `DO UPDATE`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OnDuplicateQueryCompiler } from '@spinajs/orm';
import { SqliteOnDuplicateQueryCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class NewerWinsUpsertCompiler extends SqliteOnDuplicateQueryCompiler {
  public compile() {
    const output = super.compile();

    // only rows that carry an UpdatedAt column get the guard
    if (!output.expression.includes('DO UPDATE') || !this._builder.getColumnsToUpdate().includes('UpdatedAt')) {
      return output;
    }

    return { ...output, expression: output.expression.replace(' RETURNING ', ' WHERE excluded.`UpdatedAt` > `UpdatedAt` RETURNING ') };
  }
}

@Injectable('orm-driver-sqlite-newer-wins')
@NewInstance()
export class NewerWinsSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(NewerWinsUpsertCompiler).as(OnDuplicateQueryCompiler);
  }
}
```

A skipped update returns no `RETURNING` row for that conflict.

### Insert compiler: custom implementation

Refuse inserts that leave a column out of some rows, even where the driver could render `NULL`, so a batch never stores `NULL` by accident.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ColumnStatement, InsertQueryCompiler } from '@spinajs/orm';
import { SqliteInsertQueryCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class UniformRowsInsertCompiler extends SqliteInsertQueryCompiler {
  public compile() {
    const columns = this._builder.getColumns();
    const ragged = this._builder.Values.findIndex((row) => row.some((value) => value === undefined));

    if (ragged !== -1 && this._builder.Values.length > 1) {
      const missing = columns.filter((_c, i) => this._builder.Values[ragged][i] === undefined).map((c) => String((c as ColumnStatement).Column));
      throw new InvalidArgument(`insert into ${this._builder.Table}: row ${ragged} has no value for ${missing.join(', ')}`);
    }

    return super.compile();
  }
}

@Injectable('orm-driver-sqlite-uniform-rows')
@NewInstance()
export class UniformRowsSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(UniformRowsInsertCompiler).as(InsertQueryCompiler);
  }
}
```

### Insert response: custom implementation

Count rows written per connection, eg. for an import report.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DbServerResponse, ServerResponseMapper } from '@spinajs/orm';
import { SqliteOrmDriver, SqliteServerResponseMapper } from '@spinajs/orm-sqlite';

export class CountingResponseMapper extends SqliteServerResponseMapper {
  public static RowsInserted = 0;

  public read(data: any, pkNames?: string[]): DbServerResponse {
    const response = super.read(data, pkNames);
    CountingResponseMapper.RowsInserted += response.RowsAffected;
    return response;
  }
}

@Injectable('orm-driver-sqlite-counting')
@NewInstance()
export class CountingSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(CountingResponseMapper).as(ServerResponseMapper);
  }
}
```

The mapper runs for model inserts, unit-of-work saves and the write capture; a raw `driver.insert()` resolves with the driver's result without calling it.

### Model to row: custom implementation

Trim text before every model insert and update. Extending `SqliteModelToSqlConverter` keeps its SQLite rule: `undefined` is left out.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ModelBase, ModelToSqlConverter } from '@spinajs/orm';
import { SqliteModelToSqlConverter, SqliteOrmDriver } from '@spinajs/orm-sqlite';

export class TrimmingModelToSqlConverter extends SqliteModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const row = super.toSql(model) as Record<string, unknown>;

    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string') {
        row[column] = value.trim();
      }
    }

    return row;
  }
}

@Injectable('orm-driver-sqlite-trimming')
@NewInstance()
export class TrimmingSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(TrimmingModelToSqlConverter).as(ModelToSqlConverter);
  }
}
```

## Important behaviour

- `RETURNING` rows arrive in insert order, which is how a batch of `auto`-key models gets one key each.
- `LastInsertId` of a plain `Insert` is `sqlite3`'s `lastID`: the **last** row id of the statement, or of an earlier statement on the connection when this one inserted nothing.
- `INTEGER PRIMARY KEY DESC` is not a rowid alias (an SQLite quirk), yet the table info flags it `AutoIncrement`: a row inserted without a key stores `NULL` as its key, and the rowid rule reports the hidden rowid as the key. Declare an integer key without `DESC`.
- For `uuid` and `assigned` keys `LastInsertId` means nothing: SQLite's internal row id on a plain insert, `0` from `RETURNING` rows. The model keeps the key it generated; check `RowsAffected` for success.
- A multi-row upsert updates each conflicting row with its own values (`excluded.col`).
- `onDuplicate()` without `update()` emits `DO NOTHING`: a conflicting row is kept as it is and returns no `RETURNING` row.
- `onDuplicate()` without a target and with no `Unique` model column throws `OrmException('no unique or primary key columns defined in table <t>')`.
- Conflict-target and `SET` column names are quoted with the `IdentifierQuoter`.
- `orReplace()` deletes the conflicting row and inserts a new one: its other columns take defaults, and `ON DELETE` actions fire if foreign keys are enforced.
- `orIgnore()` with `returning()` returns no row for a skipped insert.
- A multi-row insert whose rows set different columns renders `NULL` for the gaps only when the column is known to be nullable without a default (model inserts); a raw `driver.insert()` with such gaps throws `InvalidArgument`, because the driver cannot tell what the table default is.
- An insert of more than 32766 bound values runs as several statements, so it reaches the database as more than one round trip. `RowsAffected` is the total over all of them.
- A unique or primary key failure is `UniqueViolation` on every path (`Insert`, `InsertReturning`, `Upsert`); other constraint failures are `ConstraintViolation`. See [Connection and driver](01-connection.md#errors).

## Best practices

- Name the conflict target in `onDuplicate('Sku')` instead of relying on `Unique` metadata.
- Give every row of a batch the same set of columns; use `null` for "no value", not `undefined`.
- Use `returning(['Id'])` on raw inserts when you need the keys; `LastInsertId` only gives the last one.

## Patterns and antipatterns

```ts
// Don't: one statement per row; a multi-row upsert gives every row its own values
for (const row of [{ Sku: 'A', Price: 10 }, { Sku: 'B', Price: 20 }]) {
  await driver.insert().into('prices').values(row).onDuplicate('Sku').update(['Price']);
}

// Do
await driver.insert().into('prices').values([{ Sku: 'A', Price: 10 }, { Sku: 'B', Price: 20 }]).onDuplicate('Sku').update(['Price']);
```

```ts
// Don't: row 1 has no Note; a raw insert cannot tell the table default, so it throws InvalidArgument
await driver.insert().into('tickets').values([{ Title: 'Printer' }, { Title: 'VPN', Note: 'urgent' }]);

// Do
await driver.insert().into('tickets').values([{ Title: 'Printer', Note: null }, { Title: 'VPN', Note: 'urgent' }]);
```

## Examples

### Import tickets and read back their keys

```ts sample
import { DI } from '@spinajs/di';
import { IInsertResult, OrmDriver } from '@spinajs/orm';

export async function importTickets(titles: string[]): Promise<number[]> {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['main'])!;

  const result = (await driver
    .insert()
    .into('tickets')
    .values(titles.map((Title) => ({ Title })))
    .returning(['Id'])) as IInsertResult;

  return result.Returning.map((row: { Id: number }) => row.Id);
}
```

### Keep a price list in sync by SKU

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function upsertPrice(sku: string, price: number) {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['main'])!;

  // INSERT INTO `prices` (`Sku`,`Price`) VALUES (?,?) ON CONFLICT(`Sku`) DO UPDATE SET `Price` = excluded.`Price` RETURNING *;
  return await driver.insert().into('prices').values({ Sku: sku, Price: price }).onDuplicate('Sku').update(['Price']);
}
```

### Save a model and use its generated key

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('main')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Number: string;

  public Total: number;
}

export async function createInvoice(number: string, total: number): Promise<number> {
  const invoice = new Invoice({ Number: number, Total: total });

  // the driver appends RETURNING `Id`, and the key is set on the model
  await invoice.insert();

  return invoice.Id;
}
```

## Related

- [Query compilers](../orm-sql/02-query-compilers.md): the shared `SqlInsertQueryCompiler` and how compilers are resolved.
- [Unit of work](../orm/07-unit-of-work.md): how cascaded saves use `insertReturning` and generated keys.
- [Converters and hydration](../orm/04-converters-and-hydration.md): `ModelToSqlConverter`, `ObjectToSqlConverter` and value converters.
- [Connection and driver](01-connection.md#errors): how insert errors are mapped.
