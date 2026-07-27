# Dialect notes

## Feature support

```ts
public supportedFeatures(): ISupportedFeature {
  return { events: true, insertReturning: false, insertIdIsFirstOfBatch: true };
}
```

| Feature | Value | Consequence |
| --- | --- | --- |
| `events` | `true` | Database scheduled events work. |
| `insertReturning` | `false` | `InsertQueryBuilder.returning()` **throws `NotSupported`**. Generated keys come from `LAST_INSERT_ID()`. |
| `insertIdIsFirstOfBatch` | **`true`** | The only driver where it holds. A multi-row insert's keys can be walked forwards from the reported id. |

All four isolation levels are declared.

## The contiguous-key guarantee

This is the most consequential thing about the MySQL driver, and it is a documented InnoDB
guarantee rather than an assumption.

InnoDB splits inserts into two kinds:

- **Simple inserts** — the row count is known before execution. `INSERT INTO t (...) VALUES
  (...), (...)` is one, and it is the only shape `InsertQueryBuilder` can produce.
- **Bulk inserts** — `INSERT ... SELECT`, where the count is not known.

For a *simple* insert, InnoDB reserves one contiguous block of N auto-increment values under a
short mutex it releases immediately, and `LAST_INSERT_ID()` reports **the first of them**. So the
k-th row of the statement gets `LAST_INSERT_ID() + k`.

This holds under `innodb_autoinc_lock_mode = 2`, the MySQL 8 default. The "values may not be
contiguous" caveat in the MySQL manual is about *bulk* inserts and about mixed-mode inserts —
neither of which the builder produces.

### When the ORM actually uses it

`Model.insert([...])` backfills keys positionally only when **every** guard passes:

1. `insertIdIsFirstOfBatch` is true — MySQL only.
2. The model has exactly **one** primary key column, with `auto` generation. A composite key has
   no single counter, and `uuid` / `assigned` keys are already set.
3. `InsertBehaviour` is `None`. `INSERT IGNORE`, `REPLACE` and `ON DUPLICATE KEY UPDATE` are
   mixed-mode: rows can be skipped, replaced or updated, so the k-th allocated id stops belonging
   to the k-th input row. (The array path rejects these outright anyway.)
4. The reported `LastInsertId` is a finite number greater than zero.
5. `RowsAffected === rows.length` — the server confirms one row inserted per row sent.
6. **No** input row carried an explicit key. A batch where some rows supply one is mixed-mode:
   InnoDB allocates values only for the rows that omitted a key, so index arithmetic would both
   mis-key the generated rows and overwrite the supplied ones.

If any guard fails, **nothing is assigned** — the ORM does not guess. Re-select, or insert one
row at a time.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('mysql')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

export async function batch() {
  const rows = [new Article({ Title: 'One' }), new Article({ Title: 'Two' }), new Article({ Title: 'Three' })];

  await Article.insert(rows);

  // On MySQL each instance now carries its generated key.
  return rows.map((r) => r.Id);
}
```

The unit of work does **not** rely on this. `SubjectExecutor` inserts one statement per row
deliberately, because a subject's key is needed by the very next subject in the order.

## No `RETURNING`

```ts sample
import { Connection, Model, ModelBase, Primary, createQuery, InsertQueryBuilder } from '@spinajs/orm';

@Connection('mysql')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

export function willThrow() {
  const { query } = createQuery(Article, InsertQueryBuilder);

  // NotSupported: driver orm-driver-mysql does not support RETURNING on INSERT
  return () => query.returning(['Id']);
}
```

Throwing is deliberate: silently ignoring the call is how this API was a no-op on MySQL and
MSSQL for years. Read keys back through `LAST_INSERT_ID()` — which the ORM does for you — or
re-select.

## `MysqlServerResponseMapper`

Normalizes `mysql2`'s `OkPacket` into `{ RowsAffected, LastInsertId, Returning }`.
`Returning` is always empty, since the dialect echoes nothing back.

`LastInsertId` reports `0` for a `uuid` or `assigned` key on a **successful** insert — those have
no identity semantics. Only `RowsAffected` is a meaningful success signal for them, which is why
`fp.ts`'s `_insert` tests that field rather than the id.

## Type mapping

MySQL is the dialect `@spinajs/orm-sql`'s generic compilers were written against, so the type
mapping is the generic one with no overrides:

| ORM type | MySQL |
| --- | --- |
| `string` | `VARCHAR(n)`, default 255 |
| `text`, `tinytext`, `mediumtext`, `longtext` | the same names |
| `int`, `tinyint`, `smallint`, `mediumint`, `bigint` | the same names |
| `float`, `double`, `decimal` | `TYPE(precision, scale)`, defaults `8, 2` |
| `boolean` | `BOOLEAN` |
| `date`, `dateTime`, `time`, `timestamp` | the same names |
| `enum` | `ENUM('a','b')` |
| `set` | `SET('a','b')` |
| `json` | `JSON` |
| `binary` | `BINARY(n)`, default 255 |
| `tinyblob`, `mediumblob`, `longblob` | the same names |

Auto-increment is `AUTO_INCREMENT`. Upserts are `ON DUPLICATE KEY UPDATE`. `TRUNCATE TABLE`
works and **resets** the auto-increment counter.

`@Uuid` columns pair with `table.uuid(name)` — `BINARY(16)` — which is what `UuidConverter`
writes.

Native `SET` columns are real here, so `@Set()` and `whereInSet` / `whereNotInSet` map onto
`FIND_IN_SET` against an actual `SET` column rather than an emulation.

## Compiler overrides

Only two, which is a fair measure of how closely the generic layer tracks MySQL:

| Token | Implementation |
| --- | --- |
| `TableExistsCompiler` | `MySqlTableExistsCompiler` — queries `information_schema.tables` |
| `ServerResponseMapper` | `MysqlServerResponseMapper` |

Everything else comes from [`@spinajs/orm-sql`](../../orm-sql/docs/), including multi-column
`ORDER BY` — unlike SQLite, which reduces it to one column.

## Database events

`events: true`, so the schema builder's event API works.

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('mysql')
export class ScheduleCleanup_2026_07_27_21_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    const event = connection.schema().event('purge_old_sessions');
    event.every().hour(1);
    event.comment('Delete sessions older than a day');
    event.do(connection.del().from('sessions').where('CreatedAt', '<', '2026-01-01'));

    await event;
  }

  public async down(connection: OrmDriver): Promise<void> {
    if (!connection.supportedFeatures().events) {
      return;
    }

    await connection.schema().dropEvent('purge_old_sessions');
  }
}
```

The MySQL event scheduler must be running (`SET GLOBAL event_scheduler = ON`), and the user needs
the `EVENT` privilege. Guard with `supportedFeatures().events` regardless, so the same migration
is safe on SQLite.

## `tableInfo`

Reflection queries `information_schema`, scoped by `Options.Database`. It populates `Name`,
`Type`, `NativeType` (the full `int(10) unsigned` form), `MaxLength`, `Unsigned`, `Nullable`,
`DefaultValue`, `PrimaryKey`, `AutoIncrement`, `Unique` and `Comment`, plus foreign-key details.

A rich `NativeType` matters beyond display: the orphan-policy resolver refuses to act on a column
whose `NativeType` is empty, treating it as "the database never told us".

## DDL is not transactional

`Migration.Transaction.Mode = PerMigration` opens a transaction, but MySQL commits implicitly
before each DDL statement. A migration that fails after its third `CREATE TABLE` leaves all three
applied.

Practical consequences:

- Keep migrations small, so a partial application is easy to reason about.
- Write `down()` defensively — it may run against a half-applied `up()`.
- Do not rely on rollback for schema changes. Data changes inside `data()` *are* transactional.

## MariaDB

The driver targets `mysql2`, which speaks MariaDB's protocol, and the two are compatible for
everything documented here. The one thing worth verifying on MariaDB is the contiguous-key
guarantee: it derives from InnoDB's `innodb_autoinc_lock_mode` semantics, so confirm that
variable's value before relying on positional batch key backfill.

## Summary

| Behaviour | MySQL |
| --- | --- |
| `RETURNING` | Not supported — throws |
| Batch key backfill | Supported, under six guards |
| Events | Supported |
| Isolation levels | All four |
| `TRUNCATE` | Real, resets the counter |
| Multi-column `ORDER BY` | Supported |
| Native `SET` / `ENUM` | Yes |
| DDL in a transaction | No — implicit commit |
| Composite keys with auto-increment | Allowed by the engine, but the ORM's batch backfill declines to key them |
