# Dialect notes

## Feature support

```ts
public supportedFeatures(): ISupportedFeature {
  return { events: false, insertReturning: true, insertIdIsFirstOfBatch: false };
}
```

| Feature | Value | Consequence |
| --- | --- | --- |
| `events` | `false` | No database scheduled events. Guard event migrations with `connection.supportedFeatures().events`. |
| `insertReturning` | **`true`** | The only shipped driver with it. Generated keys come back exactly, including from multi-row inserts. |
| `insertIdIsFirstOfBatch` | `false` | `sqlite3_last_insert_rowid()` is the **last** rowid, not the first. SQLite opts out of the positional batch backfill — it does not need it, because it has `RETURNING`. |

`SupportedIsolationLevels` is `['SERIALIZABLE']`.

## Type mapping

`SqliteColumnCompiler` maps the ORM's `ColumnType` onto SQLite's four storage classes.

| ORM type | SQLite |
| --- | --- |
| `binary`, `tinyblob`, `mediumblob`, `longblob` | `BLOB` |
| `string`, `text`, `tinytext`, `mediumtext`, `longtext` | `TEXT` |
| `date`, `dateTime`, `time`, `timestamp` | `TEXT` |
| `set`, `enum` | `TEXT` |
| `float`, `double` | `REAL` |
| `decimal` | `DECIMAL` |
| `int`, `tinyint`, `smallint`, `mediumint`, `bigint` | `INTEGER` |
| `boolean` | `BOOLEAN NOT NULL CHECK (col IN (0, 1))` |

Datetimes are stored as ISO-8601 **text**; `SqlDatetimeValueConverter` handles the round-trip.
`enum` and `set` have no native equivalent — they are text, with `SqlSetConverter` splitting and
joining on commas. There is no `SET` constraint, so values are not enforced by the database.

Column modifiers are emitted in this order: `UNSIGNED`, `CHARACTER SET`, `COLLATE`, `NOT NULL`,
`DEFAULT`, `COMMENT`, `PRIMARY KEY`, `AUTOINCREMENT`, `UNIQUE`.

Note `AUTOINCREMENT` — one word, unlike MySQL's `AUTO_INCREMENT`.

## Composite primary keys

SQLite rejects two inline `PRIMARY KEY` column constraints (`table ... has more than one primary
key`), so `SqliteTableQueryCompiler` clears `InlinePrimaryKey` on every key column and emits a
table-level constraint instead. That is handled for you.

What is **not** possible: an auto-increment column inside a composite key. `AUTOINCREMENT` is
only legal on a single `INTEGER PRIMARY KEY`, so the compiler throws rather than emit invalid
SQL:

```
sqlite cannot auto-increment column X: it is part of the composite primary key of T
```

Use `@Primary({ generated: 'uuid' })` or `'assigned'` for composite keys.

## `ALTER TABLE` limitations

SQLite's `ALTER TABLE` supports little beyond adding a column and renaming, and the driver has to
work around one specific trap.

**Booleans.** `CREATE TABLE` renders a boolean as `BOOLEAN NOT NULL CHECK (col IN (0,1))`. SQLite
refuses to `ADD COLUMN` a `NOT NULL` column without a non-null default, so that unconditional
`NOT NULL` makes every boolean add fail against a table that already holds rows.
`SqliteAddColumnCompiler` therefore drops the `NOT NULL` from the boolean definition, keeps the
`CHECK` (legal in `ADD COLUMN`, and still enforcing the 0/1 domain), and leaves nullability to
the ordinary `notNull()` flag. So `.notNull().default().value(0)` still produces a non-nullable
column:

```ts sample
import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('sqlite')
export class AddFlags_2026_07_27_20_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('articles', (table) => {
      // Works against a populated table: the default makes NOT NULL legal.
      // `addColumn()` is the default alteration mode, so it can be left off — and it
      // has to be, if you chain `default()`: `.default().value(x)` returns the base
      // ColumnQueryBuilder, which no longer carries the alter-mode methods.
      table.boolean('IsPublished').notNull().default().value(0);
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('articles', (table) => {
      table.dropColumn('IsPublished');
    });
  }
}
```

**`PRIMARY KEY` and `UNIQUE` are deliberately not stripped** from the add path. SQLite cannot add
such a column at all, and suppressing the clause would silently produce a column *without* the
constraint the developer asked for. Failing loudly is the right answer; recreate the table
instead.

## `TRUNCATE`

SQLite has no `TRUNCATE TABLE`. `SqliteTruncateTableQueryCompiler` emits `DELETE FROM <table>`,
so `Model.truncate()` and `driver.truncate(name)` work — but the auto-increment counter is **not**
reset, unlike MySQL's `TRUNCATE`.

## Upsert

`SqliteOnDuplicateQueryCompiler` emits `ON CONFLICT (...) DO UPDATE SET ...` rather than MySQL's
`ON DUPLICATE KEY UPDATE`. SQLite requires an explicit conflict target, so a model with no unique
or primary key columns throws:

```
no unique or primary key columns defined in table T
```

`InsertQueryBuilder.onDuplicate()` defaults the conflict target to the model's `Unique` columns
when you do not name one.

## `RETURNING`

`SqliteInsertQueryCompiler` appends `RETURNING` to a plain `INSERT`. It is **skipped when an
upsert clause is present** — the `ON CONFLICT` compiler emits its own `RETURNING`, and two would
be invalid SQL.

This is what lets SQLite read generated keys back precisely, and why the unit of work does not
need the positional batch backfill here.

## `ORDER BY`

`SqliteOrderByCompiler` emits **only the first sort entry** — it calls `getSort()`, not
`getSorts()`. Multi-column ordering is silently reduced to one column on this driver.

```ts sample
import { Connection, Model, ModelBase, Primary, SortOrder } from '@spinajs/orm';

@Connection('sqlite')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Views: number;

  public Title: string;
}

export async function ordering() {
  // On SQLite this compiles to `ORDER BY Views DESC` only — the Title sort is dropped.
  return await Article.select().order('Views', SortOrder.DESC).order('Title', SortOrder.ASC);
}
```

Use a `RawQuery` in the sort position, or sort in memory, when you need more than one column.

## Joins

`SqlLiteJoinStatement` overrides the generic join. The engine bundled with the sqlite3 Node
package predates `RIGHT JOIN` support, which is why the core's `Model.populate()` uses a
`LEFT JOIN` even where a right join would read more naturally.

## `tableInfo`

Reflection uses `PRAGMA table_info`, `PRAGMA index_list` and `PRAGMA foreign_key_list`, producing
`IColumnDescriptor` entries with `Name`, `Type`, `NativeType`, `Nullable`, `PrimaryKey`,
`AutoIncrement`, `DefaultValue`, `Unique` and foreign-key details.

Because SQLite's typing is dynamic, `NativeType` reflects the *declared* type, which is what the
converter type-map matches on.

## `SqliteModelToSqlConverter`

Registered over the standard one. It exists because SQLite's parameter binding accepts a narrower
set of JavaScript types than the other drivers — values are normalised before binding.

## `SqliteServerResponseMapper`

Reads back:

- a **`RETURNING`** result, which arrives as an array of rows: `RowsAffected` is the row count,
  `LastInsertId` is the key from the **last** row when there is a single key column and it is
  numeric, and `Returning` holds the rows;
- a **plain run**, which carries `{ RowsAffected, LastInsertId }` and no rows.

A `uuid` or `assigned` key is not a number and has no identity semantics, so `LastInsertId`
reports `0` for it — which is why `RowsAffected` is the only meaningful success signal for those
strategies.

## Compiler overrides in full

| Token | Implementation |
| --- | --- |
| `ColumnQueryCompiler` | `SqliteColumnCompiler` |
| `AlterColumnQueryCompiler` | `SqliteAlterColumnQueryCompiler` |
| `TableQueryCompiler` | `SqliteTableQueryCompiler` |
| `OrderByQueryCompiler` | `SqliteOrderByCompiler` |
| `JoinStatement` | `SqlLiteJoinStatement` |
| `OnDuplicateQueryCompiler` | `SqliteOnDuplicateQueryCompiler` |
| `InsertQueryCompiler` | `SqliteInsertQueryCompiler` |
| `TableExistsCompiler` | `SqliteTableExistsCompiler` |
| `DefaultValueBuilder` | `SqlLiteDefaultValueBuilder` |
| `TruncateTableQueryCompiler` | `SqliteTruncateTableQueryCompiler` |
| `ModelToSqlConverter` | `SqliteModelToSqlConverter` |
| `ServerResponseMapper` | `SqliteServerResponseMapper` |

Everything else comes from [`@spinajs/orm-sql`](../../orm-sql/docs/).

## Summary of limitations

| Limitation | Workaround |
| --- | --- |
| No database events | Guard with `supportedFeatures().events`. |
| No `TRUNCATE` (counter not reset) | Accept, or drop and recreate the table. |
| Multi-column `ORDER BY` reduced to one | Raw SQL, or sort in memory. |
| No auto-increment in a composite key | `uuid` or `assigned` key generation. |
| `ALTER TABLE` cannot add `PRIMARY KEY` / `UNIQUE` columns | Recreate the table. |
| Writes serialize on one handle | Expected; size `Pool.Max` for reads. |
| `SERIALIZABLE` only | Do not request another level. |
| Read pool disabled for `:memory:` | Expected — each handle would get its own database. |
