# Query dialect

How `SELECT`s and `WHERE` clauses come out on SQLite: one-column `ORDER BY`, no `RIGHT JOIN`, set membership with `instr`, backtick identifiers, `LIMIT ? OFFSET ?`. Everything not listed here is the shared `@spinajs/orm-sql` spelling; see [Query compilers](../orm-sql/02-query-compilers.md) and [Statements](../orm-sql/03-statements.md).

## How it works

1. A select builder compiles with the shared `SqlSelectQueryCompiler`. For each clause it resolves a token from the driver container.
2. **`ORDER BY`**: `OrderByQueryCompiler` is `SqliteOrderByCompiler`. It reads `getSort()`, the **first** sort entry, and renders `` ORDER BY [`alias`.]`column` ASC|DESC ``. Later `order()` / `orderBy()` / `orderByDescending()` calls are dropped.
3. **Joins**: `JoinStatement` is `SqlLiteJoinStatement`. Its constructor throws `NotSupported('join method RIGHT JOIN is not supported by sqlite driver')` for `JoinMethod.RIGHT` and `RIGHT_OUTER`; every other method builds like `SqlJoinStatement`.
4. **Set membership**: `whereInSet(col, values)` / `whereNotInSet(...)` resolve `InSetStatement`: `SqliteInSetStatement`. Each value becomes `(instr(',' || IFNULL(col, '') || ',', ?) > 0)` with the binding `,value,`; several values are joined with `OR`; `whereNotInSet` negates each and joins with `AND`. An empty value list gives `(1 = 0)`, or `(1 = 1)` when negated. A value containing `,` throws `InvalidArgument`.
5. **Limit**: `LimitQueryCompiler` is the shared `SqlLimitQueryCompiler`: ` LIMIT ?` for `take(n)`, ` OFFSET ?` for `skip(n)`, and ` LIMIT 18446744073709551615` for `skip()` without `take()`.
6. **Recursive CTEs**: `RecursiveQueryCompiler` is the shared `SqlWithRecursiveCompiler` (`WITH RECURSIVE recursive_cte(...) AS ( ... )`).
7. **Quoting**: `IdentifierQuoter` is `BacktickIdentifierQuoter` (`` `name` ``, embedded backticks doubled; `quoteQualified('db.t')` gives `` `db`.`t` ``). `LiteralQuoter` is `SqlLiteralQuoter`: strings with doubled `'`, booleans as `1` / `0`, dates through the datetime converter. Literals are used where bindings cannot go, eg. view bodies.

```ts
// whereInSet('Roles', ['admin', 'editor']) on SQLite
// WHERE ((instr(',' || IFNULL(`Roles`, '') || ',', ?) > 0) OR (instr(',' || IFNULL(`Roles`, '') || ',', ?) > 0))
// bindings: [',admin,', ',editor,']
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Connections[].AliasSeparator` | `string` | `$` | | Wraps generated table aliases: `` `$users$` ``. SQLite accepts `$` in quoted names. |

## Services and extension points

All registered by `SqliteOrmDriver.resolve()` in the connection's child container, new instance per resolve.

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Sort clause | `OrderByQueryCompiler`, constructor `(builder: OrderByBuilder)` | `SqliteOrderByCompiler` (exported) | `SqlOrderByQueryCompiler` from `@spinajs/orm-sql`: every sort, quoted with `IdentifierQuoter` | Register `SqlOrderByQueryCompiler`, or subclass either. |
| Join | `JoinStatement`, constructor `(options: IJoinStatementOptions)` | `SqlLiteJoinStatement` (**not exported**) | `SqlJoinStatement` (allows `RIGHT JOIN`) | Register `SqlJoinStatement` or a subclass of it; override `clone()` in a subclass. |
| Set membership | `InSetStatement`, constructor `(column, values, not, tableAlias?)` | `SqliteInSetStatement` (**not exported**) | `SqlInSetStatement` (portable `LIKE`) | Extend `InSetStatement` from `@spinajs/orm`; implement `build()` and `clone()`. |
| Limit / offset | `LimitQueryCompiler` | `SqlLimitQueryCompiler` | | Subclass `SqlLimitQueryCompiler`; override `compile()`. |
| Recursive CTE | `RecursiveQueryCompiler` | `SqlWithRecursiveCompiler` | | Subclass and register. |
| Identifiers | `IdentifierQuoter` | `BacktickIdentifierQuoter` from `@spinajs/orm-sql` | | Subclass `IdentifierQuoter` from `@spinajs/orm`, implement `quote()`; see [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md). Hard-coded backticks in `SqliteOrderByCompiler`, `SqliteInsertQueryCompiler` and `SqliteColumnCompiler` stay. |
| Literals | `LiteralQuoter` | `SqlLiteralQuoter` | | Subclass; override `quoteString()`, `quoteBoolean()`, `quoteDate()`. |

### Sort clause: custom implementation

Order by several columns on SQLite. The shared compiler renders every sort entry.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { OrderByQueryCompiler } from '@spinajs/orm';
import { SqlOrderByQueryCompiler } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-multisort')
@NewInstance()
export class MultiSortSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlOrderByQueryCompiler).as(OrderByQueryCompiler);
  }
}
```

### Join: custom implementation

The `sqlite3` package used here bundles SQLite 3.44, and `RIGHT JOIN` works since SQLite 3.39. Register the shared join statement to allow it.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { JoinStatement } from '@spinajs/orm';
import { SqlJoinStatement } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@Injectable('orm-driver-sqlite-right-join')
@NewInstance()
export class RightJoinSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqlJoinStatement).as(JoinStatement);
  }
}
```

### Set membership: custom implementation

Match set members case-insensitively, so `Admin` in the column matches `admin` in the query. `SqliteInSetStatement` is not exported, so extend `InSetStatement`.

```ts sample
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, IQueryStatement, IQueryStatementResult, SET_DELIMITER } from '@spinajs/orm';
import { _columnWrap } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class NoCaseInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const bindings: string[] = [];

    const expressions = this.values().map((value) => {
      bindings.push(`${SET_DELIMITER}${value.toLowerCase()}${SET_DELIMITER}`);
      return `(instr(lower('${SET_DELIMITER}' || IFNULL(${column}, '') || '${SET_DELIMITER}'), ?) > 0)`;
    });

    return { Bindings: bindings, Statements: [this.combine(expressions)] };
  }

  public clone(): IQueryStatement {
    const copy = new NoCaseInSetStatement(this._column, this._val, this._not, this._tableAlias!);
    // a clone is built with `new`, so the injected quoter has to be carried over
    copy.Quoter = this.Quoter;
    return copy;
  }
}

@Injectable('orm-driver-sqlite-nocase-sets')
@NewInstance()
export class NoCaseSetsSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(NoCaseInSetStatement).as(InSetStatement);
  }
}
```

### Limit / offset: custom implementation

SQLite rejects `LIMIT 18446744073709551615` with `SQLITE_MISMATCH: datatype mismatch`, so `skip()` without `take()` fails. SQLite reads `LIMIT -1` as "no limit".

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, LimitQueryCompiler } from '@spinajs/orm';
import { SqlLimitQueryCompiler } from '@spinajs/orm-sql';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class SqliteNoLimitCompiler extends SqlLimitQueryCompiler {
  public compile(): ICompilerOutput {
    const output = super.compile();
    return { ...output, expression: (output.expression ?? '').replace('LIMIT 18446744073709551615', 'LIMIT -1') };
  }
}

@Injectable('orm-driver-sqlite-offset')
@NewInstance()
export class OffsetSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(SqliteNoLimitCompiler).as(LimitQueryCompiler);
  }
}
```

## Important behaviour

- Only the first sort entry is rendered; the compiler does not use `IdentifierQuoter` (backticks are hard-coded) and does not handle `RawQuery` sorts.
- `RIGHT JOIN` and `RIGHT OUTER JOIN` throw `NotSupported` when the join statement is created; `FULL OUTER JOIN` is not refused. The core's `populate()` uses `LEFT JOIN`.
- `SqlLiteJoinStatement` has no `clone()`, so a cloned query carries a plain `SqlJoinStatement` and no longer refuses `RIGHT JOIN`.
- Set membership never matches a `NULL` column, so `whereNotInSet` returns rows whose column is `NULL`.
- `skip()` without `take()` fails with `SQLITE_MISMATCH` (see the limit sample above).
- `like` comparisons follow SQLite: case-insensitive for ASCII letters only.
- `whereIn()` / `whereNotIn()` with more than 1000 strings or numbers binds the list as one JSON parameter, `` `col` IN (SELECT value FROM json_each(?)) ``, so a key list is not capped by the 32766-parameter limit.

## Best practices

- Sort by one column on the stock driver, or register `SqlOrderByQueryCompiler` for the connections that need more.
- Use `whereInSet()` for `@Set()` columns; never a `LIKE '%value%'`, which matches prefixes and substrings.
- Always pair `skip()` with `take()` on SQLite.

## Patterns and antipatterns

```ts
// Don't: on the stock SQLite driver the Title sort is silently dropped
await Article.select().order('Views', SortOrder.DESC).order('Title', SortOrder.ASC);

// Do: register SqlOrderByQueryCompiler (MultiSortSqliteDriver above), or sort in memory
const rows = await Article.select().order('Views', SortOrder.DESC);
rows.sort((a, b) => b.Views - a.Views || a.Title.localeCompare(b.Title));
```

## Examples

### Find editors among users whose roles are stored as a set

```ts sample
import { Connection, Model, ModelBase, Primary, Set } from '@spinajs/orm';

@Connection('main')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Login: string;

  @Set()
  public Roles: string[];
}

export async function editors() {
  // instr(',' || IFNULL(`Roles`, '') || ',', ',editor,') > 0
  return await User.where('Login', 'like', '%').whereInSet('Roles', ['editor']);
}
```

### Page through invoices

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('main')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Number: string;
}

export async function invoicePage(page: number, size = 50) {
  // ORDER BY `Id` DESC LIMIT ? OFFSET ?
  return await Invoice.select().orderByDescending('Id').take(size).skip(page * size);
}
```

## Related

- [Query builder](../orm/05-query-builder.md): `order()`, joins, `whereInSet()`, `take()` / `skip()`.
- [Statements](../orm-sql/03-statements.md): statement tokens and the `clone()` contract.
- [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md): `BacktickIdentifierQuoter`, `SqlLiteralQuoter`.
- [Extending an existing dialect](../orm-sql/08-extending-an-existing-dialect.md): more driver-subclass recipes for SQLite.
