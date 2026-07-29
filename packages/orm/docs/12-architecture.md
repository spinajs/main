# Architecture

How the pieces fit, for anyone extending or debugging the ORM.

## Layering

```
  application models
        │
  @spinajs/orm            decorators, descriptors, builders, relations, unit of work
        │                 ── contains no SQL ──
  @spinajs/orm-sql        SqlDriver + generic SQL statements and compilers
        │
  orm-sqlite / orm-mysql / orm-mssql
                          dialect overrides, connection handling, tableInfo
```

The core defines **abstract** statement and compiler classes (`WhereStatement`,
`SelectQueryCompiler`, …). It never instantiates them directly — it resolves them from the
driver's DI container, which is where a dialect binds its concrete versions. That indirection is
the whole reason the core can be SQL-free.

## How a query becomes SQL

```
Model.where('Age', '>', 30)
  │
  ├─ createQuery(model, SelectQueryBuilder)
  │     ├─ read the descriptor
  │     ├─ resolve the driver from the model's connection
  │     ├─ resolve the builder from driver.Container
  │     ├─ set table + alias, add the soft-delete filter
  │     └─ add DiscriminationMapMiddleware when the model has one
  │
  ├─ .where(...)        → container.resolve(WhereStatement, [...])   → SqlWhereStatement
  │
  ├─ await              → Builder.execute()  (memoized)
  │     ├─ QueryMiddleware.beforeQueryExecution for every middleware
  │     ├─ driver.execute(builder)
  │     │     └─ SqlDriver.execute: builder.toDB() → executeOnDb(expression, bindings, context)
  │     │           └─ toDB(): container.resolve(SelectQueryCompiler, [builder]).compile()
  │     │
  │     ├─ IBuilderMiddleware.afterQuery on the raw rows
  │     ├─ per row: modelCreation (reverse order, first non-null wins)
  │     │           → DI.resolve('__orm_model_factory__', [model])
  │     │           → model.hydrate(row); IsDirty = false; takeSnapshot()
  │     │           → snapshotRelation for every already-populated relation
  │     └─ await IBuilderMiddleware.afterHydration(models)   ← relations load here
  │
  └─ SelectQueryBuilder._run unwraps the array when takeFirst() was used
```

Two ordering details in there are load-bearing.

**The middleware list is snapshotted after the driver call.** Compiling the query is what
registers the relation middlewares — the driver calls `toDB()` — so that is the first point at
which the list is complete. Everything downstream runs against an immutable copy, and
`Array.prototype.reverse()` is never called on the live array (it mutates in place, and used to
flip `modelCreation` resolution order on every execution).

**The snapshot is taken before `afterHydration`.** That is the one moment when the instance's
columns hold exactly what the database returned. Relation members attached later by the
`afterHydration` middlewares record their own member keys into that same snapshot. Relation data
that arrived *on the row itself* (a `belongsTo` `LEFT JOIN`) was attached by the hydrators before
the snapshot existed, so their `snapshotRelation` calls no-opped — `_run` re-records those
immediately after `takeSnapshot()`.

## `createQuery`

Every builder in the ORM is constructed through it, which is what keeps table naming, schema
qualification, escaping and the soft-delete filter consistent across the ActiveRecord, relation
and unit-of-work paths.

```ts sample
import { Connection, Model, ModelBase, Primary, createQuery, SelectQueryBuilder } from '@spinajs/orm';

@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
  @Primary()
  public Id: number;

  public Name: string;
}

export async function manual() {
  // `injectModel: false` produces a builder that returns raw rows rather than models.
  const { query, description, container, model } = createQuery(User, SelectQueryBuilder);

  return {
    rows: await query.select('*').where('Name', 'like', 'A%'),
    table: description.TableName,
    hasContainer: Boolean(container),
    modelName: model.name,
  };
}
```

It throws `model X does not have model descriptor. Use @model decorator on class` when the
descriptor is missing.

## Statements

A statement is one compilable fragment. The core declares them abstract; `@spinajs/orm-sql`
implements them and each driver overrides what it must.

| Abstract | Concrete in orm-sql |
| --- | --- |
| `RawQueryStatement` | `SqlRawStatement` |
| `WhereStatement` | `SqlWhereStatement` |
| `WhereQueryStatement` | `SqlWhereQueryStatement` |
| `BetweenStatement` | `SqlBetweenStatement` |
| `InStatement` | `SqlInStatement` |
| `InSetStatement` | `SqlInSetStatement` |
| `ExistsQueryStatement` | `SqlExistsQueryStatement` |
| `ColumnStatement` | `SqlColumnStatement` |
| `ColumnRawStatement` | `SqlColumnRawStatement` |
| `ColumnMethodStatement` | `SqlColumnMethodStatement` |
| `JoinStatement` | `SqlJoinStatement` |
| `GroupByStatement` | `SqlGroupByStatement` |
| `WithRecursiveStatement` | `SqlWithRecursiveStatement` |
| `LazyQueryStatement` | `SqlLazyQueryStatement` |
| `DateWrapper` / `DateTimeWrapper` | `SqlDateWrapper` / `SqlDateTimeWrapper` |

Every statement implements `build(): IQueryStatementResult` and `clone(builder)`. Cloning
preserves the per-statement boolean connector, which a naive rebuild would reset to `AND`.

`ColumnStatement` validates the column against the model descriptor at construction, allowing
properties that exist on the prototype without a decorator and primary keys declared only via
`@Primary`. Anything else throws `column X not exists in model Y`.

## Compilers

One compiler per query shape, all abstract in the core and resolved from the driver's container:

`SelectQueryCompiler` `InsertQueryCompiler` `UpdateQueryCompiler` `DeleteQueryCompiler`
`OnDuplicateQueryCompiler` `TableQueryCompiler` `AlterTableQueryCompiler`
`AlterColumnQueryCompiler` `ColumnQueryCompiler` `IndexQueryCompiler`
`ForeignKeyQueryCompiler` `LimitQueryCompiler` `OrderByQueryCompiler` `GroupByQueryCompiler`
`JoinQueryCompiler` `RecursiveQueryCompiler` `TruncateTableQueryCompiler`
`TableCloneQueryCompiler` `TableHistoryQueryCompiler` `TableExistsCompiler`
`DropTableCompiler` `DropViewCompiler` `EventQueryCompiler` `DropEventQueryCompiler`
`RawSchemaQueryCompiler`.

Each returns `ICompilerOutput` — `{ expression, bindings }` — or an array of them for
multi-statement DDL.

`TableAliasCompiler` is a `@Singleton` that renders a table reference with its alias, honouring
`Options.AliasSeparator`.

## The DI registration map

| Key | Registered by | Purpose |
| --- | --- | --- |
| `__models__` | `@Model` | Model discovery. |
| `__migrations__` | `@Migration` | Migration discovery. |
| `OrmConnection` | `Orm.createConnections()` | Factory: name → driver, `null` when unknown. |
| `Orm` | DI | The ORM service itself. |
| `__orm_model_factory__` | application / driver | Builds a model instance during hydration. |
| `__orm_relation_has_many_factory__` | driver | Builds a `hasMany` relation object. |
| `__orm_relation_has_many_to_many_factory__` | driver | Builds a `manyToMany` relation object. |
| `__orm_db_value_converters__` | `Orm.registerDefaultConverters()` + application | Map of native type name → converter class. |
| `ModelHydrator` | `hydrators.ts`, application | Hydrator chain. |
| `QueryMiddleware` | application | Global query hooks. |
| `ModelMiddleware` | application | Model lifecycle hooks. |
| `ExistsRelationHandler` | `existsRelationHandlers.ts` | One per relation type, for `whereExists`. |
| `ServerResponseMapper` | **each driver** | Normalizes insert responses. |
| `ModelToSqlConverter` / `ObjectToSqlConverter` | `OrmDriver.resolve()` | Model → SQL payload. |
| every compiler / statement token | driver's `resolve()` | Dialect bindings. |

Note the container hierarchy: `OrmDriver.resolve()` creates a **child container** per driver, so
every dialect binding is scoped to its own connection. Two connections on different dialects
coexist without stepping on each other.

## The relation machinery

`IOrmRelation` implementations, resolved by `SelectQueryBuilder._getRelationInstance` from the
relation's `RelationType`:

| Class | Handles | Strategy |
| --- | --- | --- |
| `BelongsToRelation` | `One` | `LEFT JOIN` on the main query. |
| `BelongsToRecursiveRelation` | `One` + `@Recursive` | Recursive CTE. |
| `OneToManyRelation` | `Many` | Follow-up query in `afterHydration`. |
| `ManyToManyRelation` | `ManyToMany` | Junction query plus target join. |
| `QueryRelation` | `Query` | The decorator's callback. |
| `VirtualRelation` | `Virtual` | Your relation class. |

Each registers an `IBuilderMiddleware` on the owning builder:

| Middleware | Role |
| --- | --- |
| `HasManyRelationMiddleware` | Loads `hasMany` members keyed on the parents just hydrated. |
| `HasManyToManyRelationMiddleware` | Same, through the junction table. |
| `BelongsToRelationRecursiveMiddleware` | Assembles a recursive `belongsTo` chain. |
| `BelongsToPopulateDataMiddleware` | Attaches joined `belongsTo` data. |
| `BelongsToRelationResultTransformMiddleware` | Reshapes joined columns back into nested objects. |
| `QueryRelationMiddleware` | Runs a `@Query` relation's callback and mapper. |
| `VirtualRelationMiddleware` | Delegates to a `@Virtual` relation class. |
| `DiscriminationMapMiddleware` | Chooses the concrete model class per row. |

A `One` relation nested under a `OneToManyRelation` is deliberately given a `null` owner
relation, keeping its column aliases and hydration independent of the parent query.

## Descriptor storage

Descriptors are **own** metadata per class, under `MODEL_DESCTRIPTION_SYMBOL`.

`extractModelDescriptor` reads `Reflect.getOwnMetadata` — the class's own descriptor only.
`extractModelDescriptorInherited` collapses the whole prototype chain onto a fresh default.
Because every stored descriptor is already collapsed, array fields gain no duplicates per
inheritance level; the de-duplication a name-keyed store needed is now structural.

The read side must stay paired with the write side in `decorators.ts` `_getMetadataFrom`. Both
use own-metadata-per-class. The predecessor was a *name-keyed* container, which collapsed two
classes sharing a name into one slot and broke under minification.

## Primary key helpers

`primary-keys.ts` is the single place that knows a key may be composite. Anything reasoning about
keys should go through it rather than touching `descriptor.PrimaryKey` directly.

| Function | Purpose |
| --- | --- |
| `pkColumns(d)` | Key column names. |
| `hasPk(d)` / `isCompositePk(d)` | Predicates. |
| `normalizePkTuple(d, value)` | Scalar / array / object → tuple in key order. |
| `pkValueOf(source, d)` | Read the key: scalar or tuple. |
| `setPkValue(target, d, value)` | Write it. |
| `pkKeyString(source, d)` / `pkKeyStringFor(source, keys)` | Flatten to a string. |
| `wherePk(builder, d, value)` | `WHERE` for one key. |
| `whereAnyPk(builder, d, values)` | `WHERE` for many. |
| `whereNotAnyPk(builder, d, values)` | The negation. |
| `orderByPk(builder, d, order)` | Order by the key. |
| `pkGeneration(d, column)` | The column's generation strategy. |
| `generateClientSideKeys(target, d)` | Fill `uuid` keys. |
| `assertAssignedKeys(target, d)` | Throw when an `assigned` key is missing. |

## The migration layer

Two modules, split along one line: anything that spans connections is orchestration, anything
that touches a database is execution.

| Module | Owns |
| --- | --- |
| `migration-runner.ts` | `MigrationRunner` — the `orm.Migration` facade. Validates and orders the migration registry, groups it by the connection each migration declared, and dispatches each group to that connection's `OrmMigrationService`. Touches no database itself. |
| `migration-service.ts` | `OrmMigrationService` (abstract) and `DefaultMigrationService` — the per-connection contract: tracking-table storage and upgrade, the lock, batches, checksums, transaction wrapping, failure rows and `resolve`. |

`MigrationRunner` is constructed from an `IMigrationRunnerHost` — just `{ Migrations, Connections }`
— rather than from `Orm`, which is what makes it testable without booting one. The service is
selected per connection by the `Migration.Service` DI token and resolved from the driver's own
child container with the driver as its argument, so a dialect can replace migration execution
without replacing the runner. See
[10-schema-and-migrations.md](10-schema-and-migrations.md).

## Recurring hazards in this codebase

These show up throughout the source comments and are worth internalising.

**A composite key is a tuple, and a tuple is always truthy.** `if (!pk)` is wrong for a
composite key — check every element. `destroy()`, `save()`'s reload pass and the executor's
backfill all do.

**`PrimaryKey` is `string[]`.** Passing it where a column name is expected compiles to a column
literally named `0`.

**Empty `IN ()` matches nothing.** `whereIn(c, [])` compiles to `FALSE`, never "no condition".

**An empty array is truthy.** `if (description.PrimaryKey)` is true for `[]`; use an explicit
length check.

**Inherited descriptor members are shared by reference** until detached. See
[03-models-and-decorators.md](03-models-and-decorators.md).

**A relation joins on exactly one column pair.** Composite keys have no defensible default and
must be named explicitly.

**Builders execute at most once.** `clone()` for a second round-trip.

## Exceptions

| Exception | Meaning |
| --- | --- |
| `OrmException` | Base class. Carries connection options and the offending SQL where available. |
| `OrmNotFoundException` | `firstOrFail` / `getOrFail` found nothing. Carries the expression and bindings. |
| `OrmCycleException` | The insert order cannot be satisfied. |

From `@spinajs/exceptions`: `InvalidArgument` (bad value), `InvalidOperation` (bad state),
`NotSupported` (dialect cannot do it), `MethodNotImplemented` (contract not implemented).

## Metadata models

`metadata.ts` provides `MetadataModel` and `MetadataRelation` — a generic key/value metadata
table pattern built on `@UniversalConverter`. It is **deliberately not re-exported** from
`index.ts`, to avoid a circular dependency. Import it directly:

```ts
import { MetadataModel, MetadataRelation } from '@spinajs/orm/lib/mjs/metadata.js';
```

## Extension points, ranked by reach

| Point | Scope |
| --- | --- |
| `QueryMiddleware` | Every query on every connection. |
| `IBuilderMiddleware` | One builder. |
| `ModelHydrator` | Every hydration. |
| `ValueConverter` | One column, or one database type. |
| `ModelToSqlConverter` | One connection's write payloads. |
| Relation `type` / `factory` | One relation. |
| `QueryScope` | One model's builders. |
| `OrmMigrationService` | One connection's migration execution — see [10-schema-and-migrations.md](10-schema-and-migrations.md). |
| Custom `OrmDriver` | A whole dialect — see [orm-sql's docs](../../orm-sql/docs/04-writing-a-driver.md). |
