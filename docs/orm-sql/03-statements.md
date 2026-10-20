# Statements

A statement is one SQL fragment with its bindings: a `WHERE` predicate, a selected column, a join, a group key. Builders collect statements; compilers build and join them. Read this page to see what each shipped statement emits, to change one for a dialect, or to add a statement of your own.

## How it works

1. **Creation.** A builder method resolves an abstract statement token from `builder.Container` with its constructor arguments, eg. `where('Status', 'paid')` runs `container.resolve(WhereStatement, ['Status', '=', 'paid', builder])`. The driver's container returns its registered class, by default the `Sql*` class `SqlDriver.resolve()` bound.
2. **Collection.** The builder stores the statement in one of its lists: where statements (`builder.Statements`), columns, join statements, group statements, or the recursive CTE. A `where` statement gets the pending `AND` / `OR` connector as its `Boolean`.
3. **Alias stamping.** `SelectQueryBuilder.setAlias()` writes the alias onto every column, join and where statement it owns. Statements that hold the builder read `builder.TableAlias` at build time instead.
4. **Build.** At compile time the compiler calls `statement.build()`, which returns `IQueryStatementResult`: `{ Statements: string[]; Bindings: any[] }`. The `WHERE` compiler joins built fragments with each statement's own `Boolean`.
5. **Clone.** `SelectQueryBuilder.clone()` and `WhereBuilder.clone()` call `statement.clone(newBuilder)` on every statement. A statement that holds a builder rebinds to the one it is handed.

`IQueryStatement` (from `@spinajs/orm`):

```ts
interface IQueryStatement {
  TableAlias: string;
  Boolean: WhereBoolean; // connector before this statement in WHERE / HAVING
  OnJoin?: boolean; // set by whereOnJoin(); does not survive clone()
  build(): IQueryStatementResult;
  clone(parent?: QueryBuilder | SelectQueryBuilder | WhereBuilder<any>): IQueryStatement;
}
```

Every abstract token extends `QueryStatement`, which implements `TableAlias`, `Boolean` (default `AND`) and `OnJoin`, and leaves `build()` and `clone()` abstract.

## Statement classes

| Token | `@spinajs/orm-sql` class | Created by | SQL | Clone |
| --- | --- | --- | --- | --- |
| `WhereStatement` | `SqlWhereStatement` | `where(column, [op,] value)`, `whereNull`, `whereNotNull` | `` `alias`.`col` <OP> ? `` | rebinds `_builder`; a `RawQuery` value is inlined with its bindings instead of a `?` |
| `WhereQueryStatement` | `SqlWhereQueryStatement` | `where(function () { ... })`, `whereNot(function () { ... })` | `( <nested where> )`, `NOT ( <nested where> )`; an empty negated group is `1 = 0` | clones the nested `WhereBuilder` onto the parent, keeps the negation |
| `LazyQueryStatement` | `SqlLazyQueryStatement` | `where(Lazy)`, correlated `EXISTS` | the callback's statements, built at compile time | rebinds `context` |
| `RawQueryStatement` | `SqlRawStatement` | `where(RawQuery)` | the query verbatim | no builder |
| `InStatement` | `SqlInStatement` | `whereIn`, `whereNotIn` with values | `` `col` [NOT] IN (?,?) ``; a dialect may bind a list longer than `listThreshold` as one parameter | rebinds `_builder`; `clone()` keeps the subclass |
| `InQueryStatement` | `SqlInQueryStatement` | `whereIn`, `whereNotIn` with a sub-select | `` `col` [NOT] IN ( <sub-select> ) `` | clones the sub-select, re-correlates, rebinds the owner |
| `ExistsQueryStatement` | `SqlExistsQueryStatement` | `whereExist`, `whereNotExists` | `[NOT] EXISTS ( <sub-select> )` | clones the sub-select, re-correlates |
| `ColumnCompareStatement` | `SqlColumnCompareStatement` | `whereColumn()` | `` `a`.`x` <OP> `b`.`y` ``; an `outer()` side through the correlation source, a `Wrap` side through its wrapper | rebinds `_builder` |
| `BetweenStatement` | `SqlBetweenStatement` | `whereBetween`, `whereNotBetween` | `` `col` [NOT] BETWEEN ? AND ? `` | no builder |
| `InSetStatement` | `SqlInSetStatement` | `whereInSet`, `whereNotInSet` | see [Set membership](#set-membership) | no builder |
| `StartsWithStatement` | `SqlStartsWithStatement` | `whereStartsWith` | `` `col` LIKE ? ESCAPE '~' ``, bound `escapeLikeValue(prefix) + '%'`; a dialect extends `pattern()` for its own wildcards | no builder; `clone()` keeps the subclass |
| `ColumnStatement` | `SqlColumnStatement` | `select(column)`, `columns()` | `` `alias`.`col` as `name` ``, `*` | no builder |
| `ColumnRawStatement` | `SqlColumnRawStatement` | `select(RawQuery)` | the query verbatim | no builder |
| `ColumnConditionStatement` | `SqlColumnConditionStatement` | `selectCondition()` | `CASE WHEN <nested where> THEN 1 ELSE 0 END AS alias` | clones the nested `WhereBuilder` onto the parent |
| `ColumnMethodStatement` | `SqlColumnMethodStatement` | `min`, `max`, `sum`, `avg`, `count` | `` COUNT(`col`) as `alias` `` | no builder |
| `JoinStatement` | `SqlJoinStatement` | `innerJoin`, `leftJoin`, ..., `populate()` | see [Joins](#joins) | rebinds `_options.builder` |
| `GroupByStatement` | `SqlGroupByStatement` | `groupBy()` | `` `col` `` or a raw expression | no builder |
| `WithRecursiveStatement` | `SqlWithRecursiveStatement` | `withRecursive()`, `@Recursive` relations | the CTE members | rebinds `_query` |
| `DateWrapper`, `DateTimeWrapper` | `SqlDateWrapper`, `SqlDateTimeWrapper` | `Wrapper.Date(col)`, `Wrapper.DateTime(col)` in `where()` | `` DATE(`alias`.`col`) ``, `` DATETIME(`alias`.`col`) `` | not cloned (a wrapper is resolved at build time) |
| `TextWrapper` | `SqlTextWrapper`; `MySqlTextWrapper`, `MsSqlTextWrapper` in their drivers | `Wrapper.Text(col)` in `where()`, `whereIn()`, `whereNotIn()` | `` CAST(`alias`.`col` AS TEXT) ``, `AS CHAR` (MySQL), `AS NVARCHAR(4000)` (MSSQL) | not cloned (a wrapper is resolved at build time) |

Constructor arguments of each token are listed in [Architecture](../orm/12-architecture.md#statement-classes).

### `SqlWhereStatement`

`build()` does, in order:

1. A column that names a relation of the model becomes the relation's `ForeignKey`.
2. A `RawQuery` value (`driver.now()`, for one) is written in place of the `?` after the wrapped or quoted column, and its bindings become the statement's; no converter runs.
3. A `Wrap` column is resolved as `container.resolve(wrap.Wrapper, [column, builder.TableAlias])` and its `wrap()` is the column expression. The value is bound unconverted.
4. Otherwise the column is quoted and alias-prefixed with `_columnWrap()`. An aggregate column (`IsAggregate`) is not prefixed; it goes to `HAVING`.
5. A `ModelBase` value becomes its primary key value. A composite key throws `InvalidArgument('cannot use model X as a where value: it has a composite primary key (A, B). Compare the key columns explicitly.')`.
6. Any other value goes through the column's declared converter, or, failing that, the converter registered for the value's constructor name in `__orm_db_value_converters__` (a luxon `DateTime` is converted this way).
7. `IS NULL` and `IS NOT NULL` emit no `?` and no binding.

The operator is uppercased. Column existence is checked earlier, in the core `WhereStatement` constructor: an unknown column on a model throws `column X not exists in model Y`.

### Joins

`SqlJoinStatement.build()`:

- `JoinMethod.RECURSIVE` compiles as `INNER JOIN`; no method means `LEFT JOIN`.
- A `query` option (a `RawQuery`) is emitted verbatim after the method.
- Otherwise the source and join drivers are read from the model descriptors (or `builder.Driver` / `joinTableDriver`). Different driver classes throw `InvalidArgument('Cannot join models with different drivers. ...')`.
- A builder without an alias gets `<sep><table><sep>` (the driver's `AliasSeparator`), so joined columns stay unique.
- Both tables are prefixed with `tableQualifier(driver)`, which returns `driver.Options.Database`: `` `db`.`table` as `alias` ``. A dialect subclass overrides this protected method to return a schema, or `undefined` for no prefix. `PostgresJoinStatement` does this.
- `clone()` builds an instance of the subclass it is called on, so a dialect subclass needs no `clone()` of its own.
- The ON clause is `source.sourceTablePrimaryKey = join.joinTableForeignKey`, plus, joined with `AND`:
  - the `WHERE` of the join callback's sub-builder (built with `new SqlWhereCompiler()`), so a `LEFT JOIN` stays outer;
  - `whereOnJoin()` statements of a populated relation (`onStatements`).
- `nestedJoins` are emitted inside parentheses before the outer `ON`: `LEFT JOIN ( a AS $A$ INNER JOIN b AS $A.B$ ON ... ) ON ...`; their bindings come first.

### Sub-queries and deferred statements

- `whereExist()`, `whereNotExists()`, `whereIn()` and `whereNotIn()` correlate a ready sub-query with the builder the call is made on (`correlateWith(this)`) when it has no correlation source. `SqlColumnCompareStatement` resolves `outer(column, levels)` with `outerBuilder()`: it follows that link `levels` times, each time from the query a nested group belongs to (`queryOf()`), and qualifies the column with `qualifierOf()` (the query's alias, else its table).
- `SqlExistsQueryStatement` and `SqlInQueryStatement` compile their sub-select with `toDB()` at build time and take its bindings.
- `SqlLazyQueryStatement.build()` clones its context builder, keeps its alias (only when it has one) and correlation source, clears columns, group by, joins and where, runs the callback on the clone and returns the clone's built statements.
- `SqlWithRecursiveStatement.build()` compiles the anchor member (`clone().clearRecursive().clearJoins()`) and, after pushing a `RECURSIVE` join onto `recursive_cte`, the recursive member (`clone().clearRecursive().clearWhere().setAlias('$recursive$')`). `clearRecursive()` on both clones is what stops infinite recursion.

### Set membership

`whereInSet()` tests membership in a `@Set()` column (values joined by `SET_DELIMITER`, `,`). The shared rules live in the core `InSetStatement`: `values()` rejects `null`, `undefined` and values containing the delimiter with `InvalidArgument`; `combine()` OR-s matches, AND-s `NOT` for a negation, and turns an empty list into `(1 = 0)` / `(1 = 1)`.

| Class | Per-value test | Registered by |
| --- | --- | --- |
| `SqlInSetStatement` | `` (`c` = ? OR `c` LIKE ? ESCAPE '~' OR ... ) `` — exact, first, last, middle | `SqlDriver`; used by PostgreSQL |
| `MySqlInSetStatement` | `FIND_IN_SET(?, col) > 0` | `@spinajs/orm-mysql` |
| `SqliteInSetStatement` | `instr(',' \|\| IFNULL(col,'') \|\| ',', ?) > 0` | `@spinajs/orm-sqlite` |
| `MsSqlInSetStatement` | `CHARINDEX(?, ',' + ISNULL(col,'') + ',') > 0` | `@spinajs/orm-mssql` |

The portable form escapes `~`, `%` and `_` with `escapeLikeValue()` and `LIKE_ESCAPE_CHARACTER` (`~`).

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| Any statement token above | Builds one fragment | The `Sql*` class, or the dialect's subclass | Subclass it, register `.as(<token>)` in a driver subclass's `resolve()` after `super.resolve()` |
| A new statement token | A fragment the core has no builder method for | none | Declare an abstract token extending `QueryStatement`, implement it, register it, add a builder method through a prototype extension. See the [example](#add-wherestartswith-to-every-select-builder). |
| `_columnWrap(quoter, column, tableAlias, isAggregate?)` | Quotes and alias-prefixes a column the way the shared statements do | exported function | Call it from your statement |
| `DateWrapper`, `DateTimeWrapper` | Column expression for `Wrapper.Date()` / `Wrapper.DateTime()` | `SqlDateWrapper` (`DATE(...)`), `SqlDateTimeWrapper` (`DATETIME(...)`) | Subclass, implement `wrap()`, register |

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { DateWrapper } from '@spinajs/orm';
import { SqlDateWrapper } from '@spinajs/orm-sql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

/** PostgreSQL has no DATE() function; cast instead. */
@NewInstance()
export class PostgresDateWrapper extends SqlDateWrapper {
  public wrap(): string {
    const column = this._tableAlias ? `${this.Quoter.quote(this._tableAlias)}.${this.Quoter.quote(this._value as string)}` : this.Quoter.quote(this._value as string);
    return `CAST(${column} AS DATE)`;
  }
}

@Injectable('orm-driver-postgres-dates')
@NewInstance()
export class DatesPostgresDriver extends PostgresOrmDriver {
  public resolve() {
    super.resolve();
    this.Container.register(PostgresDateWrapper).as(DateWrapper);
  }
}
```

## Important behaviour

- `clone()` builds statements with `new`, which bypasses DI: property injection (`@Autoinject(IdentifierQuoter) Quoter`) does not run on a clone. Every shipped `clone()` copies `Quoter` onto the copy; yours must too, or the cloned statement throws on its first `quote()`.
- A subclass that does not override `clone()` turns back into its parent class on clone, because the parent's `clone()` calls `new <Parent>(...)`. Override `clone()` in every statement subclass.
- `SelectQueryBuilder.clone()` runs on every compile of a query with a `Lazy` where statement, and for every pagination count. Clone bugs are not rare-path bugs.
- `SelectQueryBuilder.clone()` does not copy `Boolean` back onto cloned statements; `WhereBuilder.clone()` does. Set `Boolean` in your `clone()` when it matters.
- Statements that hold no builder (`SqlBetweenStatement`, `SqlColumnStatement`, `SqlInSetStatement`, ...) carry the table alias as a value snapshotted at creation; `setAlias()` re-stamps it.
- `SqlInStatement` with an empty array emits `1 = 0` (`1 = 1` for `NOT IN`), because `IN ()` is a syntax error.
- `SqlInStatement` converts every value the way `SqlWhereStatement` does: through the model column's declared converter, else through the `__orm_db_value_converters__` entry named after the value's class, so a `Date` or `DateTime` becomes the dialect's datetime text. A list longer than `listThreshold` (1000) whose converted values are all strings and finite numbers is bound as ONE parameter when the dialect overrides `listExpression()` (and `listBinding()` for its shape): `= ANY(?)` / `<> ALL(?)` with an array on PostgreSQL, `IN (SELECT value FROM json_each(?))` with JSON text on SQLite, `IN (SELECT [value] FROM OPENJSON(?))` on MSSQL, where `listThreshold` is 200. MySQL and any list with another value type keep the expanded `IN (?, ...)`.
- `SqlColumnMethodStatement` never alias-prefixes its column.
- `SqlInStatement` resolves a `Wrap` column (`Wrapper.Text()`) the way `SqlWhereStatement` does and converts its values by their class only: the column's declared converter does not apply to the wrapped expression.
- `SqlDateWrapper` and `SqlDateTimeWrapper` emit `DATE()` and `DATETIME()`. The PostgreSQL driver replaces `SqlDateTimeWrapper` with `PostgresDateTimeWrapper` (`CAST(col AS TIMESTAMP)`); other drivers keep both. Check that your engine has these functions before using `Wrapper.Date()`.
- Values in DML statements are always bound with `?`, never interpolated.

## Best practices

- Subclass the dialect's statement (`SqlLiteJoinStatement`, `MySqlInSetStatement`) when the dialect has one.
- Quote through `this.Quoter` and alias-prefix through `_columnWrap()`; never write backticks.
- In `clone(parent)`, rebind every builder reference to `parent ?? <current>` and copy `Quoter`.
- Keep `build()` free of side effects on the owning builder, unless you are writing a lazy statement and the compiler expects it.

## Patterns and antipatterns

```ts
// Don't: the clone has no Quoter (DI never ran on it) and keeps pointing at the old builder
public clone(): IQueryStatement {
  return new SqlStartsWithStatement(this._column, this._prefix, this._builder);
}

// Do: rebind to the builder clone() is handed, and carry the injected quoter
public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): IQueryStatement {
  const copy = new SqlStartsWithStatement(this._column, this._prefix, (parent as WhereBuilder<unknown>) ?? this._builder);
  copy.Quoter = this.Quoter;
  copy.Boolean = this.Boolean;
  return copy;
}
```

```ts
// Don't: pushing straight onto Statements drops a pending orWhere() connector
this.Statements.push(statement);

// Do: pushStatement() stamps the pending connector and resets it
(this as unknown as { pushStatement(s: IQueryStatement): unknown }).pushStatement(statement);
```

## Examples

### Add `whereStartsWith()` to every select builder

A prefix search with `LIKE` metacharacters escaped, so `whereStartsWith('Sku', 'AB_1')` does not also match `ABX1...`.

```ts sample
import { DI, NewInstance, Autoinject } from '@spinajs/di';
import {
  escapeLikeValue,
  IdentifierQuoter,
  IQueryStatement,
  IQueryStatementResult,
  LIKE_ESCAPE_CHARACTER,
  QueryBuilder,
  QueryStatement,
  SelectQueryBuilder,
  WhereBuilder,
} from '@spinajs/orm';
import { _columnWrap } from '@spinajs/orm-sql';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Rows whose `column` starts with `prefix`, compared literally. */
    whereStartsWith(column: string, prefix: string): this;
  }
}

/** Token: what the builder method resolves. A dialect may register its own class for it. */
@NewInstance()
export abstract class StartsWithStatement extends QueryStatement {
  constructor(protected _column: string, protected _prefix: string, protected _builder: WhereBuilder<unknown>) {
    super();
  }
}

@NewInstance()
export class SqlStartsWithStatement extends StartsWithStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._builder.TableAlias);

    return {
      Statements: [`${column} LIKE ? ESCAPE '${LIKE_ESCAPE_CHARACTER}'`],
      Bindings: [`${escapeLikeValue(this._prefix)}%`],
    };
  }

  public clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): IQueryStatement {
    const copy = new SqlStartsWithStatement(this._column, this._prefix, (parent as unknown as WhereBuilder<unknown>) ?? this._builder);
    copy.Quoter = this.Quoter;
    copy.Boolean = this.Boolean;
    return copy;
  }
}

// Root registration: driver containers fall back to it, and a driver may still register its own.
DI.register(SqlStartsWithStatement).as(StartsWithStatement);

(SelectQueryBuilder.prototype as unknown as Record<string, unknown>).whereStartsWith = function (this: SelectQueryBuilder, column: string, prefix: string) {
  const statement = this.Container.resolve(StartsWithStatement, [column, prefix, this]);

  // pushStatement() is protected; it applies a pending orWhere() connector.
  (this as unknown as { pushStatement(s: IQueryStatement): unknown }).pushStatement(statement);
  return this;
};
```

Use it:

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    whereStartsWith(column: string, prefix: string): this;
  }
}

@Connection('default')
@Model('products')
export class Product extends ModelBase<Product> {
  @Primary()
  public Id: number;

  public Sku: string;
}

export async function productsInLine(line: string): Promise<Product[]> {
  return await Product.where('Sku', '!=', '').whereStartsWith('Sku', `${line}-`);
}
```

### Compare only the date part of a timestamp

```ts sample
import { Connection, ICompilerOutput, Model, ModelBase, Primary, Wrapper } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('sqlite')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public CreatedAt: DateTime;
}

export function ordersPlacedOn(day: string): ICompilerOutput {
  // SQLite: SELECT * FROM `orders` WHERE DATE(`CreatedAt`) = ?
  return Order.where(Wrapper.Date('CreatedAt'), '=', day).toDB() as ICompilerOutput;
}
```

## Related

- [Query compilers](02-query-compilers.md): how built statements are joined into a query.
- [Identifier and literal quoting](04-identifier-and-literal-quoting.md): the `Quoter` every statement uses.
- [Injecting your own builders](09-injecting-your-own-builders.md): why `clone()` matters for builder subclasses too.
- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): prototype extensions, the way to expose a new statement.
- [Query builder](../orm/05-query-builder.md): the builder methods that create these statements.
