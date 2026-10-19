# Inserts, upserts and `RETURNING`

SQLite is the driver with `RETURNING` (`insertReturning: true`), so it reads generated keys back exactly, also from multi-row inserts. This page covers how SQLite spells `INSERT`, `INSERT OR IGNORE` / `OR REPLACE`, `ON CONFLICT ... DO UPDATE` and `RETURNING`, how the raw result becomes a `DbServerResponse`, and how a model becomes an insert row.

## How it works

1. **Build.** `driver.insert().into(table).values(rowOrRows)`, or a model insert, builds an `InsertQueryBuilder` with `QueryContext.Insert`.
   - `.orIgnore()` sets `Ignore`; `.orReplace()` sets `Replace`.
   - `.returning(columns)` sets `Returning` and switches to `QueryContext.InsertReturning`. It throws `NotSupported` on drivers without `insertReturning`; SQLite has it.
   - `.onDuplicate(columns?)` switches to `QueryContext.Upsert` and returns an `OnDuplicateQueryBuilder`. Without `columns`, the conflict target is the model's columns flagged `Unique`. `.update(columns)` names the columns to overwrite.
2. **Compile.** `toDB()` resolves `InsertQueryCompiler`: `SqliteInsertQueryCompiler.compile()` joins `into()`, `columns()`, `values()`, `upsort()` and `returning()`:
   - `into()`: ``INSERT [OR IGNORE] [OR REPLACE] INTO `table` ``.
   - `columns()` / `values()` (inherited from `SqlInsertQueryCompiler`): an auto-increment primary key is left out when no row supplies it, else rendered `NULL` in the rows that do not; `null` renders `NULL`; `undefined` renders `DEFAULT`.
   - `upsort()`: when `onDuplicate()` was called and `orReplace()` was not, resolves `OnDuplicateQueryCompiler`: `SqliteOnDuplicateQueryCompiler`, which emits `ON CONFLICT(<target>) DO UPDATE SET col = ?, ... RETURNING <cols|*>;`.
   - `returning()`: ``RETURNING `a`,`b` `` (or `*`), skipped when an upsert clause is present, because `ON CONFLICT` already carries one.
3. **Execute.** `executeOnDb()` uses `run()` for `Insert` and `all()` for `InsertReturning` and `Upsert` (see [Result shapes](01-connection.md#result-shapes)).
4. **Map.** Model inserts resolve `ServerResponseMapper` (`SqliteServerResponseMapper`) and call `read(result, pkNames)`:
   - An array (upsert rows): `RowsAffected` = row count; `LastInsertId` = the key of the **last** row when there is one key column and its value is a number, else `0`; `Returning` = the rows.
   - An object: `RowsAffected`, `LastInsertId` and `Returning` copied, defaulting to `0`, `0`, `[]`.
5. **Keys back.** A model with an `auto` key asks for `RETURNING <key columns>` (`model.insert()` except with `InsertOrUpdate`, and `Model.insert(rowOrRows)`). When `Returning` has one row per inserted model, each model gets its own key, in insert order. `uuid` and `assigned` keys are set before the insert and kept.

### Model serialization

`model.toSql()` resolves `ModelToSqlConverter` from the driver container: `SqliteModelToSqlConverter`. Per column of the model descriptor:

1. Skips `Virtual` columns and foreign-key columns that a relation manages.
2. Throws `OrmException('Field <col> cannot be null')` for a non-key, non-nullable column holding `null`, `undefined` or `''`.
3. Leaves out columns whose value is `undefined`, so the table default applies. SQLite does not accept `DEFAULT` inside `VALUES`.
4. Writes the rest through the column's converter (`toDB`), if any.

Then per `belongsTo` relation it writes the foreign key: the related model's join column when the relation holds a value, else the raw foreign-key property when set, else `NULL` after a detach (`attach(null)`). A recursive relation always copies the raw foreign-key property.

The only difference from `StandardModelToSqlConverter` in `@spinajs/orm` is step 3: the standard converter keeps `undefined` values.

## Configuration

No keys. `supportedFeatures()` is fixed: `{ events: false, insertReturning: true, insertIdIsFirstOfBatch: false }`. `insertIdIsFirstOfBatch` is `false` because `sqlite3`'s `lastID` is the **last** row id of a multi-row insert; SQLite gets every key from `RETURNING` instead.

## Services and extension points

All registered by `SqliteOrmDriver.resolve()` in the connection's child container.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert compiler | `InsertQueryCompiler`, new instance, constructor `(container, builder)` | `SqliteInsertQueryCompiler` (exported) | `SqlInsertQueryCompiler` from `@spinajs/orm-sql` (no `RETURNING`, MySQL `IGNORE`) | Subclass; override `compile()`, `into()`, `returning()`, `upsort()`, `values()`, `columns()`, `autoIncrementPlaceholder()`. |
| Upsert compiler | `OnDuplicateQueryCompiler`, new instance, constructor `(builder: OnDuplicateQueryBuilder)` | `SqliteOnDuplicateQueryCompiler` (exported) | `SqlOnDuplicateQueryCompiler` (MySQL `ON DUPLICATE KEY UPDATE`) | Subclass; override `compile()`. |
| Insert response | `ServerResponseMapper`, new instance | `SqliteServerResponseMapper` (exported) | none; the base class throws `MethodNotImplemented` | Subclass `SqliteServerResponseMapper`; override `read(data, pkNames?)`. |
| Model to row | `ModelToSqlConverter`, new instance | `SqliteModelToSqlConverter` (**not exported**) | `StandardModelToSqlConverter` from `@spinajs/orm` | Extend `StandardModelToSqlConverter` and drop `undefined` values yourself, or extend `ModelToSqlConverter`. |
| Plain object to row | `ObjectToSqlConverter`, new instance, registered by `OrmDriver.resolve()` | `StandardObjectToSqlConverter` | | Used by `Model.insert()` with plain objects; it already leaves out `undefined`. |

### Upsert compiler: custom implementation

`SqliteOnDuplicateQueryCompiler` binds the **first** row's values for every updated column, so a multi-row upsert writes row 1's values into every conflicting row. SQLite's `excluded.<col>` refers to the row being inserted; use it instead.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OnDuplicateQueryCompiler, OrmException, RawQuery } from '@spinajs/orm';
import { escapeIdentifier } from '@spinajs/orm-sql';
import { SqliteOnDuplicateQueryCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class ExcludedUpsertCompiler extends SqliteOnDuplicateQueryCompiler {
  public compile() {
    const target = this._builder.getColumn();
    if (target.length === 0) {
      throw new OrmException(`no unique or primary key columns defined in table ${this._builder.getParent().Table}`);
    }

    const updates: Array<string | RawQuery> = this._builder.getColumnsToUpdate() ?? [];
    const set = updates.map((c) => (typeof c === 'string' ? `${escapeIdentifier(c)} = excluded.${escapeIdentifier(c)}` : c.Query));
    const bindings = updates.flatMap((c) => (typeof c === 'string' ? [] : c.Bindings ?? []));

    const returning = this._builder.getReturning();
    const cols = returning[0] === '*' ? '*' : returning.map((c) => escapeIdentifier(c)).join(',');
    const action = set.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${set.join(',')}`;

    return {
      bindings,
      expression: `ON CONFLICT(${target.map((c) => escapeIdentifier(c)).join(',')}) ${action} RETURNING ${cols};`,
    };
  }
}

@Injectable('orm-driver-sqlite-upsert')
@NewInstance()
export class UpsertSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(ExcludedUpsertCompiler).as(OnDuplicateQueryCompiler);
  }
}
```

With no `update()` call it emits `DO NOTHING` instead of failing on an undefined column list.

### Insert compiler: custom implementation

A multi-row insert whose rows set different columns renders `DEFAULT` for the gaps, which SQLite rejects with `near "DEFAULT": syntax error`. Fail early with a message that names the problem.

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

    if (ragged !== -1) {
      const missing = columns.filter((_c, i) => this._builder.Values[ragged][i] === undefined).map((c) => String((c as ColumnStatement).Column));
      throw new InvalidArgument(`insert into ${this._builder.Table}: row ${ragged} has no value for ${missing.join(', ')}; sqlite has no DEFAULT inside VALUES`);
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

The mapper runs for model inserts and unit-of-work saves; a raw `driver.insert()` resolves with the driver's result without calling it.

### Model to row: custom implementation

Trim text before every model insert and update. `SqliteModelToSqlConverter` is not exported, so extend `StandardModelToSqlConverter` and repeat its one SQLite rule: leave `undefined` out.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ModelBase, ModelToSqlConverter, StandardModelToSqlConverter } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

export class TrimmingModelToSqlConverter extends StandardModelToSqlConverter {
  public toSql(model: ModelBase<unknown>): unknown {
    const row = super.toSql(model) as Record<string, unknown>;

    for (const [column, value] of Object.entries(row)) {
      if (value === undefined) {
        // sqlite has no DEFAULT inside VALUES; leave the column out so the table default applies
        delete row[column];
      } else if (typeof value === 'string') {
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
- `LastInsertId` of a plain `Insert` is `sqlite3`'s `lastID`: the **last** row id of the statement.
- For `uuid` and `assigned` keys `LastInsertId` means nothing: SQLite's internal row id on a plain insert, `0` from `RETURNING` rows. The model keeps the key it generated; check `RowsAffected` for success.
- `SqliteOnDuplicateQueryCompiler` binds the first row's values: a multi-row upsert overwrites every conflicting row with row 1's values. `ExcludedUpsertCompiler` above fixes it.
- `onDuplicate()` without `update()` fails while compiling (`getColumnsToUpdate()` is undefined).
- `onDuplicate()` without a target and with no `Unique` model column throws `OrmException('no unique or primary key columns defined in table <t>')`.
- Conflict-target and `SET` column names are not quoted.
- `orReplace()` deletes the conflicting row and inserts a new one: its other columns take defaults, and `ON DELETE` actions fire if foreign keys are enforced.
- `orIgnore()` with `returning()` returns no row for a skipped insert.
- A multi-row insert whose rows set different columns renders `DEFAULT` and fails with `near "DEFAULT": syntax error`. Batch model inserts hit this when one model leaves a nullable column `undefined` and another sets it.
- A unique or primary key failure is `UniqueViolation` on every path (`Insert`, `InsertReturning`, `Upsert`); other constraint failures are `ConstraintViolation`. See [Connection and driver](01-connection.md#errors).

## Best practices

- Name the conflict target in `onDuplicate('Sku')` instead of relying on `Unique` metadata.
- Upsert one row per statement, or register `ExcludedUpsertCompiler`, when several rows can conflict.
- Give every row of a batch the same set of columns; use `null` for "no value", not `undefined`.
- Use `returning(['Id'])` on raw inserts when you need the keys; `LastInsertId` only gives the last one.

## Patterns and antipatterns

```ts
// Don't: both conflicting rows get Price 10 (row 1's value)
await driver.insert().into('prices').values([{ Sku: 'A', Price: 10 }, { Sku: 'B', Price: 20 }]).onDuplicate('Sku').update(['Price']);

// Do: one statement per row (or register ExcludedUpsertCompiler)
for (const row of [{ Sku: 'A', Price: 10 }, { Sku: 'B', Price: 20 }]) {
  await driver.insert().into('prices').values(row).onDuplicate('Sku').update(['Price']);
}
```

```ts
// Don't: row 1 has no Note, so it renders DEFAULT, which sqlite rejects
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

  // INSERT INTO `prices` (`Sku`,`Price`) VALUES (?,?) ON CONFLICT(Sku) DO UPDATE SET Price = ? RETURNING *;
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
