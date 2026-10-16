# Statements

A statement is one compilable fragment: a `WHERE` predicate, a selected column, a join, a group
key. Each implements two methods.

```ts
interface IQueryStatement {
  build(): IQueryStatementResult;                       // { Statements: string[], Bindings: any[] }
  clone(builder?: QueryBuilder): IQueryStatement;
  Boolean: WhereBoolean;                                // AND / OR connector
  TableAlias: string;
}
```

`clone()` rebuilds the statement from its parts against a new builder. `WhereBuilder.clone()`
copies `Boolean` back onto the clone afterwards, because a rebuilt statement would otherwise
reset it to the `AND` default.

## `SqlWhereStatement`

The workhorse. `build()` does five things:

1. **Relation name → foreign key.** When the column names a relation on the model, it is swapped
   for the relation's `ForeignKey`.
2. **`Wrap` columns** are handed to their `WrapStatement` (`SqlDateWrapper`,
   `SqlDateTimeWrapper`) and the result used as the column expression. Otherwise the column is
   escaped and prefixed with the table alias.
3. **A `ModelBase` value unwraps to its primary key.** A **composite** key throws rather than
   binding a tuple into a single `?`:

   ```
   cannot use model X as a where value: it has a composite primary key (A, B).
   Compare the key columns explicitly.
   ```
4. **Converter lookup.** A converter declared on the column wins. Failing that, the value's own
   constructor name is looked up in `__orm_db_value_converters__` — which is how a luxon
   `DateTime` passed as a where value is converted without any per-column declaration.
5. **Null operators bind nothing.** `IS NULL` and `IS NOT NULL` emit no `?` and no binding.

Output: `` `alias`.`column` <OPERATOR> ? ``, with the operator uppercased.

## `SqlInStatement`

```sql
`alias`.`column` IN (?, ?, ?)
```

`NOT IN` when negated. Bindings are the values.

Note that the empty-array case never reaches here — `WhereBuilder.whereIn` short-circuits to
`FALSE` before constructing a statement.

## `SqlInSetStatement`

Membership in a MySQL `SET` column, via `FIND_IN_SET`.

| Mode | SQL | Connector |
| --- | --- | --- |
| `whereInSet` | `FIND_IN_SET(?, col) > 0` | `OR` |
| `whereNotInSet` | `FIND_IN_SET(?, col) = 0` | `AND` |

Wrapped in parentheses. The connector flip is deliberate: "in any of these" is a disjunction,
"in none of these" is a conjunction.

## `SqlBetweenStatement`

```sql
`alias`.`column` BETWEEN ? AND ?
```

`NOT BETWEEN` when negated.

## `SqlColumnStatement`

An escaped column with an optional alias, prefixed with the table alias:

```sql
`$users$`.`Name` as `DisplayName`
```

A wildcard column compiles to `*` (still alias-prefixed when there is an alias).

Column existence is validated in the **core** `ColumnStatement` constructor, not here.
Properties present on the prototype without a decorator, and primary keys declared only via
`@Primary`, are allowed; anything else throws `column X not exists in model Y`.

## `SqlColumnRawStatement`

A `RawQuery` used as a selected column, passed through with its bindings.

## `SqlColumnMethodStatement`

An aggregate: `MIN`, `MAX`, `SUM`, `AVG`, `COUNT` from `ColumnMethods`.

```sql
COUNT(`$orders$`.`Id`) as `count`
```

## `SqlRawStatement`

A `RawQuery` in a `WHERE`, emitted verbatim with its bindings.

## `SqlWhereQueryStatement`

A nested group — what `where(function () { ... })` produces. Compiles its child builder and wraps
the result in parentheses, so the group's own boolean connectors stay contained.

## `SqlExistsQueryStatement`

```sql
EXISTS ( <subquery> )
```

`NOT EXISTS` when negated. The sub-query is compiled with its own bindings.

## `SqlLazyQueryStatement`

Defers building until compile time, so the statement can depend on state that does not exist at
`where()` time.

`SqlWhereCompiler` builds these **first** and reuses the result. Building a lazy statement may
append further statements to the builder — a correlated `EXISTS` registers its correlation
predicate lazily — and building up front guarantees the side effect runs exactly once, in a pass
that still sees what it appended.

## `SqlJoinStatement`

Emits the join. `JoinMethod.RECURSIVE` is compiled as `INNER JOIN`; anything unspecified
defaults to `LEFT JOIN`.

Three input shapes:

- **A raw query** — emitted verbatim.
- **A relation or model** — the ON clause is derived from the relation descriptor.
- **Explicit options** — `sourceTablePrimaryKey`, `joinTableForeignKey` and the table names.

When the join carries a `callback`, the statement builds a **sub-builder** on the joined model
and applies the callback to it. That sub-builder's `WHERE` conditions are emitted in the join's
own **ON** clause and deliberately **not** folded into the main query's `WHERE` — folding them
would silently turn a `LEFT JOIN` into an inner filter. Columns and sorts from a
`queryCallback` *are* merged, so extra joined columns keep working.

## `SqlGroupByStatement`

A group key: an escaped column, or a raw expression passed through.

## `SqlWithRecursiveStatement`

Builds the `WITH RECURSIVE` CTE by compiling two clones of the owning query — the anchor member
and the recursive member — each with `clearRecursive()`, `clearJoins()` and `clearWhere()`
applied as appropriate. Without clearing the recursive flag, compiling a member would re-enter
the recursive compiler and recurse until the stack overflowed.

## `SqlDateWrapper` / `SqlDateTimeWrapper`

Both **abstract** here — date truncation syntax is genuinely dialect-specific (`DATE()`,
`CAST(... AS DATE)`, `CONVERT(date, ...)`), so each driver implements them.

Use them through `Wrap`:

```ts sample
import { Connection, Model, ModelBase, Primary, Wrap, DateWrapper, ICompilerOutput } from '@spinajs/orm';

@Connection('sqlite')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public CreatedAt: string;
}

export function byDay(): ICompilerOutput {
  // Compare the DATE part of a datetime column, whatever the dialect spells it as.
  return Order.where(new Wrap('CreatedAt', DateWrapper), '=', '2026-07-27').toDB() as ICompilerOutput;
}
```

## Escaping helpers

| Helper | Purpose |
| --- | --- |
| `escapeIdentifier(name)` | Quote a table / column / alias. |
| `escapeStringLiteral(value)` | Escape a literal embedded in DDL — enum and set members, charset, collation, comments. |
| `_columnWrap(column, tableAlias, isAggregate?)` | Escape and alias-prefix a column, skipping the prefix for an aggregate expression. |

Values in DML are **always** bound, never interpolated. String literals are escaped only in DDL,
where the dialects do not accept placeholders.

## Overriding a statement

```ts sample
import { SqlDriver, SqlDateWrapper } from '@spinajs/orm-sql';
import { DateWrapper, QueryContext } from '@spinajs/orm';

export class MyDateWrapper extends SqlDateWrapper {
  public wrap(): string {
    return `CAST(${this._value} AS DATE)`;
  }
}

export abstract class MyDriver extends SqlDriver {
  public abstract executeOnDb(stmt: string | object, params: unknown[], context: QueryContext): Promise<unknown>;

  public resolve() {
    super.resolve();
    this.Container.register(MyDateWrapper).as(DateWrapper);
  }
}
```
