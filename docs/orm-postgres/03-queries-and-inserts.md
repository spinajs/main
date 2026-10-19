# Queries and inserts

The SQL a select, insert or upsert compiles to on a PostgreSQL connection, and how inserted keys come back. The driver replaces the MySQL spellings of the shared `@spinajs/orm-sql` layer with PostgreSQL ones and keeps the shared compilers where their SQL is already valid.

## How it works

1. **Build.** A query builder (`driver.select()`, `Model.insert()`, ...) resolves its compiler from the driver's container, for example `InsertQueryCompiler`, which on this driver is `PostgresInsertQueryCompiler`.
2. **Compile.** `builder.toDB()` produces SQL with `?` placeholders and a bindings array. Identifiers are quoted by `DoubleQuoteIdentifierQuoter`; see [Quoting and parameters](05-quoting-and-parameters.md).
3. **Send.** `PostgresOrmDriver.executeOnDb()` rewrites `?` to `$1..$n` and runs the statement; see [Connection and pooling](01-connection-and-pooling.md#how-it-works).
4. **Read keys.** For an insert, `executeOnDb()` returns `{ RowsAffected, LastInsertId: 0, Returning: rows }`. The model layer passes it to `PostgresServerResponseMapper.read(data, pkNames)` and assigns primary keys from the `RETURNING` rows.

### Select

| Builder call | SQL on PostgreSQL |
| --- | --- |
| `select('*').from('users').where('id', 1)` | `SELECT * FROM "users" WHERE "id" = ?` |
| `.take(10).skip(20)` | `... LIMIT ? OFFSET ?` (bindings `[10, 20]`) |
| `.skip(20)` | `... OFFSET ?`, no `LIMIT` (`PostgresLimitQueryCompiler`) |
| `.take(10)` | `... LIMIT ?` |
| `whereExist('Owner', cb)` | `EXISTS ( SELECT * FROM "account" as "account_exists" WHERE ... )` |
| `withRecursive('Parent_Id', 'Id')` | `WITH RECURSIVE recursive_cte("Id","Parent_Id") AS (...)` (shared `SqlWithRecursiveCompiler`) |

### Insert

`PostgresInsertQueryCompiler.compile()` builds `INSERT INTO <table> (<columns>) VALUES <rows> [ON CONFLICT DO NOTHING] [ON CONFLICT ... DO UPDATE ...] [RETURNING ...]`:

| Builder call | SQL on PostgreSQL |
| --- | --- |
| `into('users').values({ id: 1, email })` | `INSERT INTO "users" ("id","email") VALUES (?,?)` |
| auto-increment primary key not supplied by a row (other rows supply it) | `DEFAULT` in that row's tuple |
| a column value `undefined` | `DEFAULT` |
| `.orIgnore()` | `... VALUES (...) ON CONFLICT DO NOTHING` |
| `.returning(['id'])` | `... RETURNING "id"` |
| `.returning(['*'])` | `... RETURNING *` |
| `.onDuplicate('id').update(['email'])` | `... ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email" RETURNING *` |

`ON CONFLICT DO NOTHING` and the plain-insert `RETURNING` are skipped when an upsert clause is present, because the upsert compiler emits its own conflict handling and `RETURNING`.

### Upsert

`PostgresOnDuplicateQueryCompiler.compile()`:

1. Throws `OrmException('no unique or primary key columns defined in table <table>')` when the conflict target is empty.
2. Joins the quoted conflict columns into `ON CONFLICT (<cols>)`.
3. Renders each string column to update as `"col" = EXCLUDED."col"`, which applies each conflicting row's own value in a multi-row upsert, with no extra bindings. A `RawQuery` entry is copied as is, with its bindings.
4. Appends `RETURNING *` or `RETURNING "<col>",...` from the builder's returning list.

When `onDuplicate()` is called without columns on a model query, the conflict target comes from the model's columns flagged unique. `tableInfo()` flags a primary key column as unique, so a table whose only constraint is its primary key upserts on that key.

### Table references

`PostgresTableAliasCompiler` writes a table as `"table"` or `"table" as "alias"`, with no database prefix. A PostgreSQL connection is bound to one database, and the prefix position names a schema, so unqualified names resolve through `search_path`.

The shared `SqlJoinStatement` is not replaced. A join it builds from a `joinTable` or a model prefixes both tables with `Options.Database`: `LEFT JOIN "shop"."addresses" as "addresses"`. PostgreSQL reads `"shop"` as a schema. See [Important behaviour](#important-behaviour).

### Response types

`pg` returns some types as strings because they can exceed `2^53`. `PostgresOrmDriver.ResponseSchemaTypes` declares this, so JSON Schemas built for responses say `string`:

| Column type | Value read back | `ResponseSchemaTypes` entry |
| --- | --- | --- |
| `NUMERIC`, `DECIMAL` | string, e.g. `'12.50'` | `decimal: { type: 'string' }`, `numeric: { type: 'string' }` |
| `BIGINT`, `COUNT(*)` | string, e.g. `'42'` | `bigint: { type: 'string' }` |
| `INTEGER`, `SMALLINT`, `REAL`, `DOUBLE PRECISION` | number | |
| `BOOLEAN` | boolean | |
| `JSONB` | parsed object | |
| `TIMESTAMP`, `DATE` | `Date` (local time zone for `TIMESTAMP`) | |
| `BYTEA` | `Buffer` | |

On the request side these stay numbers; only response schemas change.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Insert compiler | `InsertQueryCompiler`, `@NewInstance()`, resolved per insert with `[container, builder]` | `PostgresInsertQueryCompiler` | `SqlInsertQueryCompiler` (MySQL spelling) | Subclass; override `into()`, `ignore()`, `returning()`, `autoIncrementPlaceholder()` or `compile()`. See [Customizing dialect compilers](07-customizing-dialect-compilers.md#postgresinsertquerycompiler). |
| Upsert compiler | `OnDuplicateQueryCompiler`, `@NewInstance()`, resolved by the insert compiler with `[duplicateBuilder]` | `PostgresOnDuplicateQueryCompiler` | `SqlOnDuplicateQueryCompiler` (MySQL spelling) | Subclass and override `compile()`. |
| Limit compiler | `LimitQueryCompiler`, `@NewInstance()`, resolved per select with `[builder]` | `PostgresLimitQueryCompiler` | | Subclass and override `compile()`. |
| Table reference compiler | `TableAliasCompiler`, `@NewInstance()`, resolved by every compiler that writes a table name | `PostgresTableAliasCompiler` | `SqlTableAliasCompiler` (database prefix) | Implement `compile(builder, tbl?)`. |
| Insert response mapper | `ServerResponseMapper`, registered as a class in the driver container, resolved by the model layer after an insert | `PostgresServerResponseMapper` | | Subclass and override `read(data, pkNames?)`; register in a driver subclass. |
| Response type overrides | `ResponseSchemaTypes`, public readonly field of the driver | `decimal`, `numeric`, `bigint` → `string` | | Redeclare the field in a driver subclass. |
| Date wrappers | `DateWrapper`, `DateTimeWrapper` (registered by `SqlDriver`) | `SqlDateWrapper` (`DATE(col)`), `SqlDateTimeWrapper` (`DATETIME(col)`) | | Register a PostgreSQL wrapper in a driver subclass. See the [example](#compare-the-time-part-with-a-postgresql-datetime-wrapper). |

### `PostgresServerResponseMapper`: custom implementation

`read(data, pkNames?)` turns what `executeOnDb()` returned for an insert into `DbServerResponse { RowsAffected, LastInsertId, Returning }`:

- An array (rows of an upsert's `RETURNING`): `RowsAffected` is the row count, `Returning` the rows, and `LastInsertId` the single primary key of the last row when it is a number, else `0`.
- An object from `executeOnDb()`: its `RowsAffected` and `LastInsertId`, and `Returning` when it is an array, else `[]`.

Replace it when your code reads `LastInsertId` and your keys are `BIGINT`, which `pg` returns as strings. Register the subclass after `super.resolve()` in a driver subclass.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DbServerResponse, ServerResponseMapper } from '@spinajs/orm';
import { PostgresOrmDriver, PostgresServerResponseMapper } from '@spinajs/orm-postgres';

/** Reports BIGINT identity keys ('9007199254740993' arrives as a string) as LastInsertId. */
export class BigintKeyResponseMapper extends PostgresServerResponseMapper {
  public read(data: any, pkNames?: string[]): DbServerResponse {
    const response = super.read(data, pkNames);
    const last = response.Returning[response.Returning.length - 1];
    const key = pkNames?.length === 1 && last ? last[pkNames[0]] : undefined;

    if (response.LastInsertId === 0 && typeof key === 'string' && /^\d+$/.test(key)) {
      const asNumber = Number(key);
      // keys above 2^53 cannot be represented; leave them at 0 rather than round them
      if (Number.isSafeInteger(asNumber)) {
        response.LastInsertId = asNumber;
      }
    }

    return response;
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class BigintKeysPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(BigintKeyResponseMapper).as(ServerResponseMapper);
  }
}
```

## Important behaviour

- `supportedFeatures()` returns `{ events: false, insertReturning: true, insertIdIsFirstOfBatch: false }`. The model layer therefore asks for the primary key with `RETURNING` on every insert of a model with an `auto` key, and reads keys from the returned rows, one per inserted row, in order.
- `LastInsertId` is always `0` for a plain insert: PostgreSQL has no `LAST_INSERT_ID()`. Read keys from `Returning`, or let the model layer assign them.
- A `BIGINT` primary key read back from `RETURNING` is a string, and the model receives it as a string.
- A multi-row insert where only some rows supply an auto-increment key keeps the column and writes `DEFAULT` for the rows that do not. The identity column is `GENERATED BY DEFAULT`, so both are accepted.
- `orIgnore()` without a conflict target skips a row that violates any unique constraint, primary key included.
- `onDuplicate().update([...])` takes either column names or `RawQuery` entries, not a mix. A `RawQuery` entry is copied into `DO UPDATE SET` verbatim; quote identifiers yourself.
- An insert whose columns include a `RawQuery` column is written with backticks by the shared `SqlInsertQueryCompiler.columns()`, which PostgreSQL rejects.
- Joins built by `SqlJoinStatement` from a table name or model qualify both tables with `Options.Database`, which PostgreSQL reads as a schema. Unless a schema of that name exists, the join fails with `relation "<db>.<table>" does not exist`. Workaround: create a schema named like the database and set `Options.Schema` to the same name, so the qualified and the unqualified spelling are the same table. A join built from a raw query (`options.query`) is not prefixed.
- `Wrapper.DateTime()` renders `DATETIME("col")`, which PostgreSQL does not have. `Wrapper.Date()` renders `DATE("col")`, which PostgreSQL accepts as a cast.
- `IN SET` conditions (`whereInSet`) use the shared, portable `LIKE` statement, matching the comma-joined `TEXT` that `SET` columns are stored as.
- A failed statement with SQLSTATE `23505` throws `UniqueViolation` (extends `ResourceDuplicated`) with the pg error's `table` and `constraint` and the key columns from its `detail`. Any other class `23` SQLSTATE throws `ConstraintViolation`: `23502` is `not_null`, `23503` `foreign_key`, `23514` `check`, the rest `other`. Every other error stays `OrmException`. The pg error is `inner` in all three.

## Best practices

- Convert `COUNT(*)`, `BIGINT` and `NUMERIC` results explicitly (`Number(total)`, a decimal library) at the edge of your code.
- Upsert with an explicit conflict target (`onDuplicate('email')`) that matches a unique index; PostgreSQL requires the target to match one.
- Prefer `orIgnore()` to `onDuplicate().update([])` for "insert if absent": the upsert compiler needs at least one column to update.
- Use `returning(['*'])` on a plain insert to read server-side defaults (`created_at DEFAULT now()`) without a second query.

## Patterns and antipatterns

```ts
// Don't: LastInsertId is always 0 on PostgreSQL
const res = await driver.insert().into('orders').values({ total: 10 });
const id = res.LastInsertId;

// Do: ask for the key and read it from the returned rows
const created = (await driver.insert().into('orders').values({ total: 10 }).returning(['id'])) as IInsertResult;
const id = created.Returning[0].id;
```

```ts
// Don't: MySQL's VALUES() reference is not PostgreSQL
.onDuplicate('sku').update([RawQuery.create('"stock" = VALUES("stock")')])

// Do: the row that failed to insert is EXCLUDED
.onDuplicate('sku').update([RawQuery.create('"stock" = "products"."stock" + EXCLUDED."stock"')])
```

## Examples

### Add delivered stock to existing products in one statement

```ts sample
import { DI } from '@spinajs/di';
import { Orm, RawQuery } from '@spinajs/orm';

export async function receiveDelivery(lines: Array<{ sku: string; stock: number }>): Promise<void> {
  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('main')!;

  // INSERT INTO "products" ("sku","stock") VALUES (?,?),(?,?)
  //   ON CONFLICT ("sku") DO UPDATE SET "stock" = "products"."stock" + EXCLUDED."stock" RETURNING *
  await driver
    .insert()
    .into('products')
    .values(lines)
    .onDuplicate('sku')
    .update([RawQuery.create('"stock" = "products"."stock" + EXCLUDED."stock"')]);
}
```

### Insert a row and read its server-side defaults

```ts sample
import { DI } from '@spinajs/di';
import { IInsertResult, Orm } from '@spinajs/orm';

export async function openTicket(subject: string): Promise<{ id: number; created_at: Date }> {
  const orm = await DI.resolve(Orm);
  const driver = orm.Connections.get('main')!;

  // INSERT INTO "tickets" ("subject") VALUES (?) RETURNING "id","created_at"
  const result = (await driver.insert().into('tickets').values({ subject }).returning(['id', 'created_at'])) as IInsertResult;
  return result.Returning[0];
}
```

### Compare the time part with a PostgreSQL datetime wrapper

`Wrapper.DateTime()` resolves `DateTimeWrapper` from the connection's container. Register a wrapper that casts to `TIMESTAMP` instead of calling `DATETIME()`.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DateTimeWrapper } from '@spinajs/orm';
import { SqlDateTimeWrapper } from '@spinajs/orm-sql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

@NewInstance()
export class PostgresDateTimeWrapper extends SqlDateTimeWrapper {
  public wrap(): string {
    const column = this._tableAlias ? `${this.Quoter.quote(this._tableAlias)}.${this.Quoter.quote(this._value as string)}` : this.Quoter.quote(this._value as string);
    return `CAST(${column} AS TIMESTAMP)`;
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class DateTimePostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(PostgresDateTimeWrapper).as(DateTimeWrapper);
  }
}
```

## Related

- [Query builder](../orm/05-query-builder.md): the builder API these SQL spellings come from.
- [Query compilers](../orm-sql/02-query-compilers.md): the shared compilers this driver extends or claims.
- [Statements](../orm-sql/03-statements.md): `SqlJoinStatement`, the date wrappers and the other statements inherited unchanged.
- [JSON Schema](../orm/11-json-schema.md): where `ResponseSchemaTypes` is read.
- [Customizing dialect compilers](07-customizing-dialect-compilers.md): replace any compiler on this page.
