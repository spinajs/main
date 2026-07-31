# Compilers

A compiler turns a builder into `ICompilerOutput` — `{ expression, bindings }` — or an array of
them for multi-statement DDL. Every one is resolved from the driver's container, so a dialect
overrides by re-registering the token.

## `SqlQueryCompiler<T>`

The shared base. Holds the builder and the container, and exposes them to subclasses. The
per-clause compilers (`SqlWhereCompiler`, `SqlColumnsCompiler`, …) are mixed in with
`typescript-mix`'s `@use`, which is why `SqlSelectQueryCompiler` can call `this.where(...)` and
`this.columns(...)` directly.

## `SqlSelectQueryCompiler`

The clause order in `compile()` is not cosmetic:

1. **`Relations.forEach(r => r.compile())`** — relations register their joins and middlewares.
2. **JOIN** — first, because a join (an `EXISTS` statement in particular) can change the table
   alias.
3. **WHERE** — second, for the same reason.
4. Then columns, `FROM`, `LIMIT`, `ORDER BY`, `HAVING`, `GROUP BY`.

A recursive builder short-circuits to `SqlWithRecursiveCompiler` before any of this.

Assembled shape:

```
SELECT [DISTINCT] <columns|*> FROM <table alias> [joins] [WHERE ...] [GROUP BY ...]
  [HAVING ...] [ORDER BY ...] [LIMIT ...]
```

Bindings are concatenated in join → where → group → having → sort → limit order, matching the
`?` placeholders.

An empty column list compiles to `*`.

## `SqlLimitQueryCompiler`

| Builder state | SQL |
| --- | --- |
| `limit > 0` | `LIMIT ?` |
| `limit <= 0`, `offset > 0` | `LIMIT 18446744073709551615` |
| `offset > 0` | `OFFSET ?` appended |

The magic number is `2^64 - 1`: standard SQL has no `OFFSET` without a `LIMIT`, so an
effectively-unbounded limit stands in. Dialects that support a bare `OFFSET` override this
compiler. It throws `builder cannot be null or undefined` on a missing builder.

## `SqlWhereCompiler`

Builds each statement and joins them with their own boolean connector.

One ordering rule matters: **lazy statements are built first**, and their results reused.
`LazyQueryStatement.build()` may have side effects that append further statements to the builder
— a correlated `EXISTS` sub-query registers its correlation predicate lazily — so building them
up front guarantees the side effect runs exactly once and that the appended statements are
picked up by the same pass.

`SqlHavingCompiler` is the same logic emitting a `HAVING` clause.

## `SqlColumnsCompiler`

Maps each column statement's first built fragment and joins with commas.

## `SqlGroupByCompiler`

`GROUP BY` plus the joined statements; an empty expression when there are none.

## `SqlOrderByQueryCompiler`

Emits `ORDER BY` over **every** entry from `getSorts()`, so multi-column ordering works.
Empty when there are no sorts.

## `SqlJoinCompiler`

Concatenates the built join statements.

## `SqlWithRecursiveCompiler`

Compiles the `WITH RECURSIVE` CTE. It builds two **clones** of the owning query — the anchor
member and the recursive member — with `clearRecursive()` applied, so compiling a member cannot
re-enter the recursive compiler and loop forever. `clearJoins()` and `clearWhere()` strip the
parts of the parent query the members must not inherit.

## `SqlInsertQueryCompiler`

```
INSERT INTO <table> (<columns>) VALUES (?, ?), (?, ?) [upsert clause]
```

The subtle part is `keptColumnIndices()`. An auto-increment primary key column is dropped from
the statement **only when no row supplies a value for it**. If at least one row does, the column
stays and the rows that omitted it emit `NULL`, letting the engine assign those.

Both `columns()` and `values()` derive their shape from that single decision. Deciding per-row
in one place and per-batch in the other produced value tuples whose arity did not match the
column list.

An empty `Values` array throws `values count invalid`.

`orIgnore()` and `orReplace()` change the verb; `onDuplicate()` appends the upsert clause via
`SqlOnDuplicateQueryCompiler`. `Replace` wins over `Update` — the upsert clause is skipped when
both are set.

## `SqlOnDuplicateQueryCompiler`

Emits the dialect's upsert tail from the `OnDuplicateQueryBuilder`'s conflict columns and update
list. MySQL's `ON DUPLICATE KEY UPDATE` and SQLite's `ON CONFLICT (...) DO UPDATE SET` differ
enough that SQLite overrides it.

## `SqlUpdateQueryCompiler`

```
UPDATE <table alias> SET `col` = ?, ... [WHERE ...]
```

Bindings are the `SET` values followed by the where bindings.

## `SqlDeleteQueryCompiler`

```
DELETE FROM <table alias> [WHERE ...] [LIMIT ...]
```

## `SqlTableQueryCompiler`

`CREATE TABLE`, delegating each column to `SqlColumnQueryCompiler` and each foreign key to
`SqlForeignKeyQueryCompiler`. Handles `temporary()`, `ifExists()`, the table comment and charset.

`trackHistory()` makes `compile()` return an **array**: the table statement plus everything
`SqlTableHistoryQueryCompiler` emits.

## `SqlColumnQueryCompiler`

Maps a `ColumnType` to its SQL type.

| Builder type | SQL |
| --- | --- |
| `string` | `VARCHAR(n)`, default `255` |
| `float` / `double` / `decimal` | `TYPE(precision, scale)`, defaults `8, 2` |
| `enum` | `ENUM('a','b')` |
| `set` | `SET('a','b')` |
| `binary` | `BINARY(n)`, default `255` |
| `boolean` | `BOOLEAN` |
| everything else | the type name, uppercased |

Then the modifiers, in order: `UNSIGNED`, `CHARACTER SET '...'`, `COLLATE '...'`, `NOT NULL`,
`DEFAULT ...`, `AUTO_INCREMENT`, `COMMENT '...'`, and an inline `PRIMARY KEY` when
`InlinePrimaryKey` is set.

Identifiers go through `escapeIdentifier`, and every string literal — enum and set members,
charset, collation, comment — through `escapeStringLiteral`.

`AUTO_INCREMENT` is MySQL's spelling. SQLite (`AUTOINCREMENT`) and MSSQL (`IDENTITY(1,1)`)
override it.

## `SqlAlterTableQueryCompiler`

Returns an **array** — one statement per alteration, which is what most dialects require.
Handles adds, modifies, renames, dropped columns and a table rename, delegating columns to
`SqlAlterColumnQueryCompiler`.

## `SqlForeignKeyQueryCompiler`

```
FOREIGN KEY (`col`) REFERENCES `table`(`pk`) ON DELETE <action> ON UPDATE <action>
```

Actions come from `ReferentialAction`, defaulting to `NO ACTION`.

## `SqlIndexQueryCompiler`

```
CREATE [UNIQUE] INDEX `name` ON `table` (`col`, ...)
```

## `SqlTruncateTableQueryCompiler`

`TRUNCATE TABLE <table>`. SQLite has no such statement and overrides it with a `DELETE`.

## `SqlTableCloneQueryCompiler`

Returns an array. A shallow clone emits the structure copy; a deep clone adds an
`INSERT ... SELECT`, constrained by the filter builder when one was given.

## `SqlTableHistoryQueryCompiler`

Emits the history table and the triggers that populate it, giving each row `__action__`,
`__revision__`, `__start__` and `__end__` — the `IHistoricalModel` shape read back through
`@Historical`.

## `SqlDropTableQueryCompiler` / `SqlDropViewQueryCompiler`

`DROP TABLE|VIEW [IF EXISTS] <name>`, schema-qualified when `database()` was set.

## `SqlCreateDatabaseQueryCompiler` / `SqlDropDatabaseQueryCompiler`

`CREATE DATABASE [IF NOT EXISTS] <name> [CHARACTER SET <cs>] [COLLATE <col>]` and
`DROP DATABASE [IF EXISTS] <name>`.

`CHARACTER SET` / `COLLATE` take a name — not a quotable identifier, not a bindable value — so
`assertCharsetName` rejects anything outside `[A-Za-z0-9_]` instead of interpolating it. MSSQL and
SQLite replace both compilers: T-SQL has no `CHARACTER SET` and no `IF NOT EXISTS`, and SQLite has
no server-side database at all.

## `SqlEventQueryCompiler` / `SqlDropEventQueryCompiler`

Database scheduled events, from `EventQueryBuilder`. Both return arrays. Only meaningful where
`supportedFeatures().events` is true.

## `SqlRawSchemaQueryCompiler`

Passes a `RawSchemaQueryBuilder`'s query and bindings straight through.

## `SqlTableAliasCompiler`

A `@Singleton` that renders a table reference:

```sql
`database`.`table` as `$table$`
```

The alias wrapper is `Options.AliasSeparator`. The database prefix appears only when the builder
has one.

## Not provided here

`TableExistsCompiler` has no generic implementation — every dialect answers the question
differently (`information_schema`, `sqlite_master`, `sys.tables`). Each driver registers its own.

## Overriding one

```ts sample
import { SqlDriver } from '@spinajs/orm-sql';
import { SqlLimitQueryCompiler } from '@spinajs/orm-sql';
import { LimitQueryCompiler, ICompilerOutput, ILimitBuilder, QueryContext } from '@spinajs/orm';

/** A dialect that supports a bare OFFSET, so the 2^64-1 stand-in is unnecessary. */
export class PostgresLimitCompiler extends SqlLimitQueryCompiler {
  public compile(): ICompilerOutput {
    const limits = (this as unknown as { _builder: ILimitBuilder<unknown> })._builder.getLimits();
    const bindings: unknown[] = [];
    let stmt = '';

    if ((limits.limit ?? 0) > 0) {
      stmt += ' LIMIT ?';
      bindings.push(limits.limit);
    }

    if ((limits.offset ?? 0) > 0) {
      stmt += ' OFFSET ?';
      bindings.push(limits.offset);
    }

    return { bindings, expression: stmt };
  }
}

export abstract class PostgresDriver extends SqlDriver {
  public abstract executeOnDb(stmt: string | object, params: unknown[], context: QueryContext): Promise<unknown>;

  public resolve() {
    super.resolve();
    this.Container.register(PostgresLimitCompiler).as(LimitQueryCompiler);
  }
}
```

Register **after** `super.resolve()`, so your binding replaces the generic one.
