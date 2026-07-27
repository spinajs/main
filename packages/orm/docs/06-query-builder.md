# Query builder

Four builders sit on top of a shared set of mixins: `SelectQueryBuilder`, `InsertQueryBuilder`,
`UpdateQueryBuilder` and `DeleteQueryBuilder`. The schema builders are covered separately in
[10-schema-and-migrations.md](10-schema-and-migrations.md).

## Execution

A builder is `PromiseLike`. `then()` delegates to `execute()`, and **execution is memoized** —
a builder runs at most once, and awaiting it again resolves with the same result. Call `clone()`
when you genuinely want a second round-trip.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function execution() {
  const query = User.where('Name', 'like', 'A%');

  const first = await query;
  const same = await query;         // memoized — no second round-trip
  const again = await query.clone(); // a real second query

  // Inspect the SQL without running it. Idempotent.
  const { expression, bindings } = User.select().toDB() as { expression: string | null; bindings: unknown[] | null };

  return { first, same, again, expression, bindings };
}
```

`toDB()` compiles to `{ expression, bindings }` (or an array of them for multi-statement schema
builders). It never executes.

## Building a builder without a model

`OrmDriver` exposes raw builders that bypass the model layer entirely.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function raw() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  const rows = await driver.select().from('users').where('Id', '>', 10);
  await driver.insert().into('audit').values({ Message: 'hello' });
  await driver.update().in('users').update({ Name: 'x' }).where('Id', 1);
  await driver.del().from('users').where('Id', 1);

  return rows;
}
```

## Selecting columns

| Method | Effect |
| --- | --- |
| `select(column, alias?)` | Add one column. |
| `select(rawQuery)` | Add a raw expression. |
| `select(Map<column, alias>)` | Add several with aliases. |
| `columns(names[])` | **Replace** the column list. |
| `clearColumns()` | Drop every selected column. |
| `getColumns()` | The current column statements. |
| `distinct()` | `SELECT DISTINCT`. |

When the builder has a model, `select('col')` validates the name against the descriptor and
throws `Column X does not exist on model Y` for an unknown one. Virtual columns are excluded
from the lookup. `select('*')` is special-cased and always allowed.

`distinct()` throws `Cannot force DISTINCT on unknown column` when no columns are selected or
the first one is the wildcard.

```ts sample
import { Connection, Model, ModelBase, Primary, RawQuery } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;

  public Email: string;
}

export async function columns() {
  const some = await User.query().select('Id').select('Name', 'DisplayName');

  const aliased = await User.query().select(new Map([['Email', 'Address']]));

  const computed = await User.query()
    .select('Id')
    .select(RawQuery.create('UPPER(Name) as Shouted'));

  const unique = await User.query().select('Name').distinct();

  return { some, aliased, computed, unique };
}
```

## The where family

Every method exists in `where` / `andWhere` / `orWhere` form. The boolean connector set by
`orWhere` / `andWhere` applies to the **next** pushed statement only and then resets to `AND`,
so `where(a).where(b).orWhere(c).where(d)` compiles to `a AND b OR c AND d` rather than
rewriting the whole clause.

| Method | Produces |
| --- | --- |
| `where(column, value)` | `column = value` |
| `where(column, operator, value)` | `column <op> value` |
| `where(object)` | `AND` of `key = value`, via `whereObject` |
| `where(callback)` | A parenthesised nested group |
| `where(rawQuery)` | Raw SQL with bindings |
| `where(true \| false)` | `TRUE` / `FALSE` |
| `where(wrap)` | A wrapped column, e.g. date truncation |
| `whereObject(obj)` | Same as `where(object)` |
| `whereNull(c)` / `whereNotNull(c)` | `IS NULL` / `IS NOT NULL` |
| `whereNot(c, v)` | `c != v` |
| `whereIn(c, [])` / `whereNotIn(c, [])` | `IN` / `NOT IN` |
| `whereBetween(c, [a, b])` / `whereNotBetween` | `BETWEEN` |
| `whereInSet(c, [])` / `whereNotInSet(c, [])` | Set-membership (MySQL `SET` columns) |
| `whereExist(q, cb?)` / `whereNotExists(q, cb?)` | `EXISTS` / `NOT EXISTS` |
| `when(condition, cb, elseCb?)` | Conditional clause building |
| `clearWhere()` | Drop every condition |

Valid operators (`Op`): `<` `>` `!=` `<=>` `>=` `<=` `<>` `like` `=` `rlike` `regexp`. An
invalid one throws `operator X is invalid`.

### Null handling

`where(c, null)` becomes `IS NULL`. With an explicit operator, `=` gives `IS NULL` and `!=` /
`<>` give `IS NOT NULL`; any other operator with `null` throws.

### Empty arrays

`whereIn(c, [])` compiles to `FALSE`, matching SQL's `IN ()` semantics. It deliberately does not
emit "no condition", which would silently match every row. `whereObject` routes array values
through `whereIn`, so the same rule applies there.

`undefined` and `NaN` values throw `InvalidArgument`.

```ts sample
import { Connection, Model, ModelBase, Primary, RawQuery } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;

  public Total: number;

  public Note: string;
}

export async function filtering(onlyOpen: boolean) {
  const grouped = await Order.query()
    .select('*')
    .where('Total', '>', 100)
    .andWhere(function () {
      this.where('Status', 'open').orWhere('Status', 'pending');
    });

  const nulls = await Order.query().select('*').whereNull('Note');

  const sets = await Order.query().select('*').whereIn('Status', ['open', 'closed']);

  const ranges = await Order.query().select('*').whereBetween('Total', [10, 100]);

  const conditional = await Order.query()
    .select('*')
    .when(onlyOpen, function () {
      this.where('Status', 'open');
    });

  const rawly = await Order.query()
    .select('*')
    .where(RawQuery.create('Total > (SELECT AVG(Total) FROM orders)'));

  return { grouped, nulls, sets, ranges, conditional, rawly };
}
```

### Searching by relation

Two conveniences, both handled inside `where`:

**A dotted column populates the relation and applies the condition there.**
`where('Owner.Name', 'Ada')` calls `populate('Owner', function () { this.where('Name', 'Ada') })`.

**A bare relation name resolves to its foreign key.** `where('Owner', 3)` becomes
`where('owner_id', 3)`.

The same dotted-path handling exists on `order`, `orderBy` and `orderByDescending`.

### EXISTS on a relation

`whereExist` / `whereNotExists` take either a ready sub-query or a **relation name**. Given a
name, the builder resolves an `ExistsRelationHandler` registered for that relation type and lets
it either mutate the builder or return a correlated sub-query to wrap.

```ts sample
import { Connection, Model, ModelBase, Primary, HasMany, Relation } from '@spinajs/orm';

@Connection('default')
@Model('order_items')
export class OrderItem extends ModelBase<OrderItem> {
  @Primary()
  public Id: number;

  public order_id: number;

  public Sku: string;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @HasMany(OrderItem, { foreignKey: 'order_id', primaryKey: 'Id' })
  public Items: Relation<OrderItem, Order>;
}

export async function existence() {
  const withItems = await Order.whereExists('Items', function () {
    this.where('Sku', 'like', 'ABC-%');
  });

  const empty = await Order.whereNotExists('Items', function () {});

  return { withItems, empty };
}
```

## Ordering, limits and single rows

| Method | Effect |
| --- | --- |
| `order(column, direction)` | Add a sort. |
| `orderBy(column)` / `orderByDescending(column)` | Ascending / descending shorthand. |
| `getSort()` | The **first** sort entry, or `null`. |
| `getSorts()` | All sort entries. |
| `take(n)` | `LIMIT`. Rejects negatives. |
| `skip(n)` | `OFFSET`. Rejects negatives. |
| `takeFirst()` | `LIMIT 1` and unwrap the array. |
| `first()` | `takeFirst()` and await — resolves `undefined` when empty. |
| `firstOrFail()` | `first()` or throw `OrmNotFoundException`. |
| `firstOrThrow(error)` | `first()` or throw your error. |
| `orThrow(error)` | Throw when the whole result is empty. |
| `getLimits()` | `{ limit, offset }`. |

`firstOrThrow` and `orThrow` accept either an `Error` or a function receiving the compiled
`ICompilerOutput`, which lets the error carry the offending SQL.

```ts sample
import { Connection, Model, ModelBase, Primary, SortOrder, ICompilerOutput } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;

  public Age: number;
}

export async function ordering() {
  const page = await User.query().select('*').orderBy('Name').take(20).skip(40);

  const multi = await User.query().select('*').order('Age', SortOrder.DESC).order('Name', SortOrder.ASC);

  const one = await User.query().select('*').where('Id', 1).first();

  const strict = await User.query()
    .select('*')
    .where('Id', 999)
    .firstOrThrow((output: ICompilerOutput) => new Error(`nothing matched: ${output.expression}`));

  return { page, multi, one, strict };
}
```

## Aggregates

| Method | Effect |
| --- | --- |
| `count(column?, as?)` | **Clears the column list** and selects `COUNT(...)`. Defaults to `COUNT(*) as count`. |
| `selectCount(column?, as?)` | `count()` + `takeFirst()` + `asRaw()`, resolving the number. |
| `min` / `max` / `sum` / `avg` `(column, as?)` | Add the aggregate as a column. |
| `groupBy(expression)` | `GROUP BY`. Takes a string or a `RawQuery`. |
| `clearGroupBy()` | Drop grouping. |

`count()` clearing the column list is easy to trip over: call it first, or lose your selections.

```ts sample
import { Connection, Model, ModelBase, Primary, RawQuery } from '@spinajs/orm';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public Status: string;

  public Total: number;
}

export async function aggregating() {
  const total = await Order.query().where('Status', 'open').selectCount();

  const perStatus = await Order.query()
    .select('Status')
    .sum('Total', 'Revenue')
    .groupBy('Status')
    .asRaw<Array<{ Status: string; Revenue: number }>>();

  const byMonth = await Order.query()
    .select('Status')
    .max('Total', 'Biggest')
    .groupBy(RawQuery.create('Status'))
    .asRaw<Array<{ Status: string; Biggest: number }>>();

  return { total, perStatus, byMonth };
}
```

## Raw results

`asRaw<T>()` skips model hydration entirely and resolves whatever the driver returned. Use it
for aggregates and projections that do not correspond to a model.

`resultExists()` executes and reports whether anything came back.

`all()` is a typing convenience that just calls `execute()`.

## Joins

Every join method takes the same four shapes:

- `join(RawQuery)` — raw
- `join(relationName, callback?, queryCallback?)` — derive the ON clause from a relation
- `join(ModelClass, callback?, queryCallback?)` — find the relation by target model
- `join(IJoinStatementOptions)` — spell everything out

Methods: `innerJoin`, `leftJoin`, `leftOuterJoin`, `rightJoin`, `rightOuterJoin`,
`fullOuterJoin`, `crossJoin`, and the generic `join(method, ...)`. `clearJoins()` drops them.

A relation join without a model on the builder throws `Cannot use relation join without model
defined in builder`; a model with no relations throws too.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation, JoinMethod, RawQuery } from '@spinajs/orm';

@Connection('default')
@Model('companies')
export class Company extends ModelBase<Company> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public company_id: number;

  public Name: string;

  @BelongsTo(Company, 'company_id', 'Id')
  public Company: SingleRelation<Company>;
}

export async function joins() {
  const byRelationName = await User.query().select('*').leftJoin('Company');

  const byModel = await User.query().select('*').innerJoin(Company);

  const withCondition = await User.query()
    .select('*')
    .leftJoin('Company', function () {
      this.where('Name', 'like', 'Acme%');
    });

  const explicit = await User.query().select('*').join(JoinMethod.INNER, {
    joinTable: 'companies',
    joinTableAlias: 'c',
    joinTableForeignKey: 'Id',
    sourceTablePrimaryKey: 'company_id',
  });

  const rawJoin = await User.query()
    .select('*')
    .innerJoin(RawQuery.create('JOIN companies c ON c.Id = users.company_id'));

  return { byRelationName, byModel, withCondition, explicit, rawJoin };
}
```

`IJoinStatementOptions` fields: `joinTable`, `joinTableAlias`, `joinTableForeignKey`,
`joinTableDatabase`, `joinTableDriver`, `joinModel`, `sourceModel`, `sourceTableAlias`,
`sourceTablePrimaryKey`, `sourceTableDatabase`, `method`, `query`, `callback`, `queryCallback`,
`builder`.

A join callback's `WHERE` conditions are emitted in the join's own **ON** clause, not folded into
the main query's `WHERE` — folding them would silently turn a `LEFT JOIN` into an inner filter.
Columns and sorts from the callback *are* merged.

## Recursive CTEs

`withRecursive(recursiveKeyColumn, primaryKeyColumn)` builds a `WITH RECURSIVE` common table
expression. `clearRecursive()` removes it.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('category')
export class Category extends ModelBase<Category> {
  @Primary()
  public Id: number;

  public parent_id: number;

  public Name: string;
}

export async function tree() {
  // Walk from each row up through parent_id.
  return await Category.query().select('*').withRecursive('parent_id', 'Id');
}
```

The compiler builds the CTE's anchor and recursive members from **clones** of the owning query,
and clears the recursive flag on them — a member that stayed marked recursive would re-enter the
compiler and recurse until the stack blew.

## Table and alias control

| Method | Effect |
| --- | --- |
| `from(table, alias?)` / `setTable(table, alias?)` | Set the table. Empty name throws. |
| `setAlias(alias)` | Set the alias, propagating it into existing columns, joins and conditions. |
| `database(name)` | Set the schema / database. |
| `Table` / `TableAlias` / `Database` | Read them back. |

Passing no alias to `SelectQueryBuilder.setAlias()` generates one from the table name wrapped in
`Options.AliasSeparator`.

## Soft delete

For a model with `@SoftDelete`, `createQuery` adds `DeletedAt IS NULL` to every select.
`withDeleted()` removes exactly that statement, leaving the rest of the clause intact.

## Insert builder

| Method | Effect |
| --- | --- |
| `into(table, schema?)` | Target table. |
| `values(obj \| obj[])` | Rows. An array derives the column list from the union of the objects' keys. |
| `orIgnore()` | `INSERT IGNORE`. |
| `orReplace()` | `REPLACE`. |
| `onDuplicate(column?)` | Returns an `OnDuplicateQueryBuilder`; defaults the conflict target to the model's unique columns. |
| `returning(columns)` | Ask the dialect to echo rows back. |
| `forceColumn(column, value)` | Overwrite a column on **every** row, whatever the caller supplied. |

`returning()` **throws `NotSupported`** on a dialect without it, rather than silently doing
nothing — which is how the API was a no-op on MySQL and MSSQL for years.

`forceColumn` exists for policies that must not be negotiable (rbac's ownership stamp).
`values()` cannot serve, because calling it again appends a row rather than amending one.

```ts sample
import { DI } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

export async function inserting() {
  const driver = DI.resolve<OrmDriver>('OrmConnection', ['default'])!;

  await driver.insert().into('audit').values([
    { Message: 'one', Level: 'info' },
    { Message: 'two', Level: 'warn' },
  ]);

  await driver.insert().into('counters').values({ Key: 'hits', Value: 1 }).onDuplicate('Key').update(['Value']);
}
```

## Update builder

`update(value)` sets the payload; `in(table)` sets the table. Add a `where` yourself — the
builder happily compiles an unbounded `UPDATE`.

## Delete builder

`DeleteQueryBuilder` mixes in the where and limit builders. Same warning: it will compile an
unbounded `DELETE`.

## Middleware

Two distinct hooks, and the difference is load-bearing.

### `IBuilderMiddleware` — per builder, via `.middleware()`

| Hook | When |
| --- | --- |
| `afterQuery(data)` | Raw rows are back from the driver, before anything else. |
| `modelCreation(row)` | Override model construction. Return `null` to fall through. |
| `afterHydration(models)` | Models are built and hydrated. Async. |

`modelCreation` is resolved in **reverse registration order**; the first non-null wins. The
pipeline is snapshotted after the driver call — compiling the query is what registers the
relation middlewares — and never reversed in place.

This is how relations are loaded: each `OrmRelation` registers a middleware that issues the
follow-up query in `afterHydration`.

### `QueryMiddleware` — global, resolved from DI

```ts sample
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, QueryBuilder, QueryContext, InsertQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class TenantScope extends QueryMiddleware {
  /** Runs from the builder's CONSTRUCTOR — nothing the caller does has happened yet. */
  public afterQueryCreation(query: QueryBuilder): void {
    if (query.QueryContext === QueryContext.Select) {
      (query as any).where('TenantId', 7);
    }
  }

  /** Runs immediately before execution, with the query fully assembled. */
  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof InsertQueryBuilder) {
      query.forceColumn('TenantId', 7);
    }
  }
}
```

Both hooks fire for **every** builder type — select, insert, update and delete.

Use `afterQueryCreation` to *add a constraint*. It is the wrong place to read or amend the
payload, which does not exist yet — no `values()`, no `update()` has been called.

Use `beforeQueryExecution` to *inspect or rewrite what is about to be written*. A value written
at construction would be overwritten by the caller's own `values()` call.

A middleware that throws from either hook aborts the query.

## Scopes

`QueryScope` is the base class for adding reusable, typed query methods to a model through the
static `_queryScopes` property. The builder types intersect `T['_queryScopes']`, so scope
methods appear on every builder derived from that model.

## Cloning and merging

`clone()` deep-copies columns, joins, conditions, group-by statements, limits, sorts, the CTE,
the alias and the database, and shares relations and result middlewares by reference. A cloned
builder has a fresh execution memo.

`mergeBuilder(builder, includeStatements = true)` folds another builder's columns, CTE,
distinct flag and sorts in. `mergeRelations` and `mergeStatements` are the finer-grained
versions used by the relation and join machinery.
