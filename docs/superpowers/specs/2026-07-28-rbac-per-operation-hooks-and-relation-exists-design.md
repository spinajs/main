# Per-operation RBAC hooks & relation-correlated EXISTS

Date: 2026-07-28

Two independent changes, one commit each.

1. `packages/rbac` — let a model declare a different RBAC constraint per operation
   (`rbacRead` / `rbacUpdate` / `rbacDelete` / `rbacCreate`), falling back to the existing
   generic `rbac`.
2. `packages/orm` — make `whereExist(relation, callback)` produce a correlated EXISTS for
   `RelationType.One`, so relation-based filtering works on UPDATE and DELETE builders
   instead of only on SELECT.

The two meet in models like `ContentEntries` (yourscreen), whose ownership lives two
relations away and which currently hand-writes raw SQL to express that.

## Feature 1 — per-operation RBAC hooks

### Problem

`RbacModelPermissionMiddleware.afterQueryCreation` reads one hook off the model:

```ts
const rbacFunc = (builder.Model as any)?.rbac as Function;
```

The same function therefore constrains reads, updates and deletes. A model that needs a
narrower rule for deletes than for reads — the common case, where a user may see rows they
may not remove — has nowhere to put it.

### Design

`QUERY_TO_PERMISSION` already maps builder constructor to permission scopes and is the
file's single source of truth (its inverse is derived, never hand-written). Extend the
value with the hook name so hook and scope cannot drift:

```ts
const QUERY_TO_PERMISSION = new Map<QueryBuilderType, { own: PermissionType; all: PermissionType; hook: string }>([
  [DeleteQueryBuilder, { own: 'deleteOwn', all: 'deleteAny', hook: 'rbacDelete' }],
  [UpdateQueryBuilder, { own: 'updateOwn', all: 'updateAny', hook: 'rbacUpdate' }],
  [SelectQueryBuilder, { own: 'readOwn',   all: 'readAny',   hook: 'rbacRead'   }],
  [InsertQueryBuilder, { own: 'createOwn', all: 'createAny', hook: 'rbacCreate' }],
]);
```

`context()` returns the resolved `hook` alongside `resource` / `canOwn` / `canAny`. Both
middleware hooks then resolve the function through one helper:

```ts
function rbacHook(model: unknown, hook: string, allowGenericFallback: boolean): Function | undefined
```

Resolution order: the operation-specific static, then — for reads, updates and deletes —
the generic `rbac`, then `undefined` (caller falls through to `OwnerField`).

Naming is camelCase to match the surrounding code (`rbac`, `OwnerField`, `RbacResource`).

### Insert is deliberately asymmetric

`rbacCreate` is called from `beforeQueryExecution`, where INSERT is enforced, and it
**does not fall back to the generic `rbac`**.

`rbac` has only ever been called on builders that have a WHERE clause, so every existing
implementation is where-shaped — `ContentEntries.rbac` and `EntriesGroup.rbac` both call
`whereExist`, which `InsertQueryBuilder` does not define. Falling back would turn a
silent gap into a crash on every insert for every model already using the feature.

A model that wants insert-time control declares `rbacCreate` explicitly; it receives the
`InsertQueryBuilder` as `this` and takes over from the default `OwnerField` stamping,
exactly as `rbac` takes over from the default `OwnerField` where-clause.

### Signatures

```ts
class SomeModel extends ModelBase<SomeModel> {
  static rbac(this: IWhereBuilder<SomeModel>, user: User): void;              // fallback: read/update/delete
  static rbacRead(this: SelectQueryBuilder<SomeModel>, user: User): void;
  static rbacUpdate(this: UpdateQueryBuilder<SomeModel>, user: User): void;
  static rbacDelete(this: DeleteQueryBuilder<SomeModel>, user: User): void;
  static rbacCreate(this: InsertQueryBuilder, user: User): void;              // no fallback
}
```

### Compatibility

A model declaring only `rbac` behaves exactly as before on read/update/delete, and as
before (owner-column stamping) on insert. No existing model changes behaviour.

## Feature 2 — correlated EXISTS for `RelationType.One`

### Problem

`OneExistsRelationHandler.apply` mutates the *outer* builder:

```ts
builder.whereNotNull(rel.ForeignKey);
if (callback) {
  (builder as any).rightJoin(rel.TargetModel, callback);
}
```

`UpdateQueryBuilder` mixes in `WhereBuilder` only; `DeleteQueryBuilder` mixes in
`WhereBuilder` and `LimitBuilder`. Neither defines `rightJoin`. The RBAC middleware runs
`afterQueryCreation` on all three builder types, so any model whose `rbac` reaches
ownership through a `BelongsTo` throws a `TypeError` the moment it is updated or deleted.

`ContentEntries.rbac` documents this in a comment and works around it with a hand-built
`RawQuery` correlation and a private table alias.

`ManyExistsRelationHandler` and `ManyToManyExistsRelationHandler` are already unaffected:
they return a sub-query, and the `rightJoin` the ManyToMany handler issues lands on that
sub-query, which is a `SelectQueryBuilder`.

### Why not real JOINs in UPDATE/DELETE

Rejected. It is not portable and does not remove the nesting:

- SQLite has no JOIN in UPDATE or DELETE at all. `UPDATE ... FROM` arrived in 3.33; DELETE
  never got an equivalent. `orm-sqlite` inherits `SqlUpdateQueryCompiler` /
  `SqlDeleteQueryCompiler` unchanged, and the `rbac` package's own tests run on SQLite.
- MySQL (`UPDATE a JOIN b SET ...`) and MSSQL (`UPDATE a SET ... FROM a JOIN b`) disagree
  on clause order, so `orm-sql`, `orm-mysql` and `orm-mssql` each need their own path.
- The second hop of the `ContentEntries` chain is `HasManyToMany`, which compiles to EXISTS
  regardless. Real JOINs would change the shape of the first hop only.

Total cost: four packages, three dialects, one unsupported — to change one hop.

### Design

`OneExistsRelationHandler` returns a correlated sub-query, like the other two handlers.
`buildExistsClause` already wraps a returned sub-query in `EXISTS` / `NOT EXISTS`, so no
caller changes.

For `RelationType.One`, `ForeignKey` is the column on the *source* table and `PrimaryKey`
the column on the *target* — the inverse of the Many case, so `sourcePKeyRef` cannot be
reused. A sibling helper `sourceColumnRef` resolves an arbitrary correlated source column
against the builder alias, with the same `TableName` fallback.

```ts
public apply<R>(builder, rel, _relationName, callback?): ISelectQueryBuilder | undefined {
  builder.whereNotNull(rel.ForeignKey);

  if (!callback) {
    return undefined;
  }

  const tDesc = (builder.Model as unknown as IModelStatic).getModelDescriptor();
  const alias = `${rel.TargetModel.getModelDescriptor().TableName}_exists`;
  const relQuery = rel.TargetModel.query().setAlias(alias);

  relQuery.where(
    Lazy.oF(function () {
      relQuery.where(new RawQuery(`\`${alias}\`.\`${rel.PrimaryKey}\` = ${sourceColumnRef(builder, tDesc, rel.ForeignKey)}`));
    }),
  );

  callback.apply(relQuery);

  return relQuery;
}
```

The correlation predicate is registered through `Lazy.oF` because the outer builder's alias
may be assigned after the handler runs; the lazy body reads `builder.TableAlias` at compile
time. Both existing handlers use the same pattern.

Both sides of the predicate are alias-qualified, so a callback that joins further tables
cannot make the correlation column ambiguous.

The no-callback path is unchanged: `WHERE fk IS NOT NULL` with no sub-query, since a
`BelongsTo` with a non-null FK always has its parent row.

### Behaviour change

`whereExist('<belongsTo>', callback)` on a SELECT stops emitting a `RIGHT JOIN` and starts
emitting `EXISTS`. That is the intended semantics of the method name; the join form also
leaked the joined table's columns into the outer result and turned an existence test into
a row-multiplying join.

`packages/orm/test/relation.test.ts` asserts `query.JoinStatements.length > 0` for this
case and is rewritten to assert the EXISTS statement.

### Resulting model code

`ContentEntries.rbac` loses its alias constant, `Lazy`, `RawQuery` and the
`EntriesGroupOwners` import:

```ts
public static rbac(this: IWhereBuilder<ContentEntries>, user: User) {
  this.whereExist('Group', function (this: IWhereBuilder<EntriesGroup>) {
    this.whereExist('Owners', function (this: IWhereBuilder<User>) {
      this.where('Id', user.Id);
    });
  });
}
```

## Testing

### Feature 1 — `packages/rbac/test`

Extends the existing `orm-rbac.test.ts` setup (`AsyncLocalStorage` + `SqliteOrmDriver` +
`ResourceModel`). New fixture models declaring different hook combinations, asserting:

- `rbacRead` is used for a SELECT when both it and `rbac` are declared.
- `rbacUpdate` / `rbacDelete` likewise for their builder types.
- A model declaring only `rbac` still gets it on all three of read, update, delete.
- A model declaring only `rbacDelete` falls back to `rbac` for reads and updates.
- A model declaring neither still falls through to `OwnerField`.
- `rbacCreate` is called on insert and suppresses `OwnerField` stamping.
- A model declaring `rbac` but not `rbacCreate` does **not** have `rbac` called on insert,
  and still gets `OwnerField` stamping — the asymmetry above, pinned.

### Feature 2 — `packages/orm-sql/test`, `packages/orm/test`

SQL-shape assertions belong in `orm-sql/test/model.test.ts`, next to the existing
`whereExist` alias and ManyToMany cases, using the `FakeSqliteDriver` fixture. The
`ContentEntries` shape needs a `BelongsTo` into the model that already owns a
`HasManyToMany` — added as a new relation on the existing `RelationModel` fixture.

- SELECT: `whereExist('<belongsTo>', cb)` emits a correlated EXISTS, not a JOIN.
- SELECT with `setAlias`: correlation uses the alias, not the table name.
- The `ContentEntries` chain: nested `whereExist` across `BelongsTo` then `HasManyToMany`
  produces nested EXISTS with the inner correlated to the outer sub-query's alias.
- The same chain on a **DELETE** builder compiles — the regression that motivated this.
- The same chain on an **UPDATE** builder compiles.
- `whereNotExists('<belongsTo>', cb)` emits `NOT EXISTS`.
- No callback: still plain `WHERE fk IS NOT NULL`, no sub-query.
- `packages/orm/test/relation.test.ts` — rewrite the `JoinStatements.length` assertion.

## Out of scope

- Real JOIN support in UPDATE/DELETE compilers, for the reasons above. If it is ever
  wanted it belongs behind a driver capability flag with an EXISTS fallback, as its own
  feature.
- Changing `ManyExistsRelationHandler`'s unqualified correlation LHS. It works and is
  covered by existing assertions; touching it is unrelated churn.
- Applying the new hooks in the yourscreen repo. That follows, after these land.
