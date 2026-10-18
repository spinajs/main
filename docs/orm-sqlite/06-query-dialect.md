# Query dialect

How `SELECT`s and `WHERE` clauses come out on SQLite: `ORDER BY`, joins, set membership with `instr`, backtick identifiers, `LIMIT ? OFFSET ?`. Everything not listed here is the shared `@spinajs/orm-sql` spelling; see [Query compilers](../orm-sql/02-query-compilers.md) and [Statements](../orm-sql/03-statements.md).

## How it works

1. A select builder compiles with the shared `SqlSelectQueryCompiler`. For each clause it resolves a token from the driver container.
2. **`ORDER BY`**: `OrderByQueryCompiler` is `SqliteOrderByCompiler`. It reads `getSorts()` and renders every sort entry, in call order, as `` [`alias`.]`column` ASC|DESC ``, joined with `, `. Names are quoted with the `IdentifierQuoter`.
3. **Joins**: `JoinStatement` is `SqlLiteJoinStatement`, which builds exactly like `SqlJoinStatement`. `RIGHT JOIN` works: the bundled SQLite is 3.44 and has it since 3.39.
4. **Set membership**: `whereInSet(col, values)` / `whereNotInSet(...)` resolve `InSetStatement`: `SqliteInSetStatement`. Each value becomes `(instr(',' || IFNULL(col, '') || ',', ?) > 0)` with the binding `,value,`; several values are joined with `OR`; `whereNotInSet` negates each and joins with `AND`. An empty value list gives `(1 = 0)`, or `(1 = 1)` when negated. A value containing `,` throws `InvalidArgument`.
5. **Limit**: `LimitQueryCompiler` is `SqliteLimitQueryCompiler`: ` LIMIT ?` for `take(n)`, ` OFFSET ?` for `skip(n)`, and ` LIMIT -1` (SQLite's "no limit") for `skip()` without `take()`.
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
| Sort clause | `OrderByQueryCompiler`, constructor `(builder: OrderByBuilder)` | `SqliteOrderByCompiler` (exported) | `SqlOrderByQueryCompiler` from `@spinajs/orm-sql` (direction copied as given) | Subclass `SqliteOrderByCompiler`; override `compile()`. |
| Join | `JoinStatement`, constructor `(options: IJoinStatementOptions)` | `SqlLiteJoinStatement` (exported) | `SqlJoinStatement` | Subclass `SqlLiteJoinStatement`; override `clone()` in a subclass. |
| Set membership | `InSetStatement`, constructor `(column, values, not, tableAlias?)` | `SqliteInSetStatement` (exported) | `SqlInSetStatement` (portable `LIKE`) | Subclass `SqliteInSetStatement`, or extend `InSetStatement` from `@spinajs/orm`; implement `build()` and `clone()`. |
| Limit / offset | `LimitQueryCompiler` | `SqliteLimitQueryCompiler` (exported) | `SqlLimitQueryCompiler` (MySQL's `LIMIT 18446744073709551615`) | Subclass `SqliteLimitQueryCompiler`; override `compile()`. |
| Recursive CTE | `RecursiveQueryCompiler` | `SqlWithRecursiveCompiler` | | Subclass and register. |
| Identifiers | `IdentifierQuoter` | `BacktickIdentifierQuoter` from `@spinajs/orm-sql` | | Subclass `IdentifierQuoter` from `@spinajs/orm`, implement `quote()`; see [Identifier and literal quoting](../orm-sql/04-identifier-and-literal-quoting.md). Hard-coded backticks in `SqliteInsertQueryCompiler` and `SqliteColumnCompiler` stay. |
| Literals | `LiteralQuoter` | `SqlLiteralQuoter` | | Subclass; override `quoteString()`, `quoteBoolean()`, `quoteDate()`. |

### Sort clause: custom implementation

Sort `NULL`s last in both directions, as PostgreSQL does for `ASC`. SQLite has `NULLS LAST` since 3.30.

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { ICompilerOutput, OrderByQueryCompiler } from '@spinajs/orm';
import { SqliteOrderByCompiler, SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class NullsLastOrderByCompiler extends SqliteOrderByCompiler {
  public compile(): ICompilerOutput {
    const output = super.compile();
    return { ...output, expression: (output.expression ?? '').replace(/ (ASC|DESC)(?=,|$)/g, ' $1 NULLS LAST') };
  }
}

@Injectable('orm-driver-sqlite-nulls-last')
@NewInstance()
export class NullsLastSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(NullsLastOrderByCompiler).as(OrderByQueryCompiler);
  }
}
```

### Set membership: custom implementation

Match set members case-insensitively, so `Admin` in the column matches `admin` in the query. The whole expression changes, so this extends `InSetStatement` rather than `SqliteInSetStatement`.

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

## Important behaviour

- Every sort entry is rendered, in call order; `RawQuery` sorts are not handled.
- All join methods build as in `SqlJoinStatement`; the core's `populate()` uses `LEFT JOIN`.
- Set membership never matches a `NULL` column, so `whereNotInSet` returns rows whose column is `NULL`.
- `skip()` without `take()` renders `LIMIT -1 OFFSET ?`.
- `like` comparisons follow SQLite: case-insensitive for ASCII letters only.

## Best practices

- Add a unique column as the last sort when paging, so rows with equal sort values keep their order between pages.
- Use `whereInSet()` for `@Set()` columns; never a `LIKE '%value%'`, which matches prefixes and substrings.

## Patterns and antipatterns

```ts
// Don't: sort in memory what the database can sort
const rows = await Article.select().order('Views', SortOrder.DESC);
rows.sort((a, b) => b.Views - a.Views || a.Title.localeCompare(b.Title));

// Do: ORDER BY `Views` DESC, `Title` ASC
await Article.select().order('Views', SortOrder.DESC).order('Title', SortOrder.ASC);
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
