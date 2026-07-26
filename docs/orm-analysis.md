# ORM Analysis: `@spinajs/orm`, `@spinajs/orm-sql`, `@spinajs/orm-mysql`

*Analysis date: 2026-07-13. Scope: ~11,700 lines of source across the three packages, plus their test suites. Every finding marked **CONFIRMED** was verified by tracing the actual code path; findings marked **PLAUSIBLE** are strongly indicated but were not exercised end-to-end.*

---

## 1. Architecture overview

### 1.1 Package layering

```
@spinajs/orm        core: model layer, query builders, statements (abstract),
                    relations, hydration, migrations, DI tokens
      ▲
@spinajs/orm-sql    abstract MySQL-flavored dialect: concrete Sql* statements
                    and compilers, value converters, SqlDriver (abstract)
      ▲
@spinajs/orm-mysql  concrete driver: connection pool, transactions,
                    tableInfo introspection, MySQL-specific compilers
```

The core package defines **abstract token classes** (`SelectQueryCompiler`, `WhereStatement`, `TableAliasCompiler`, …). Dialect packages bind concrete subclasses to those tokens in the driver's `resolve()`:

- `SqlDriver.resolve()` ([orm-sql/src/index.ts](../packages/orm-sql/src/index.ts)) registers every `Sql*` statement/compiler/converter into the driver's **child DI container**.
- `MySqlOrmDriver.resolve()` ([orm-mysql/src/index.ts:122](../packages/orm-mysql/src/index.ts#L122)) additionally binds `MySqlTableExistsCompiler` and `MysqlServerResponseMapper`.
- Drivers self-register via `@Injectable('orm-driver-mysql')`; the config `Driver` string selects the implementation.

Each connection has its own child container, so different connections can use different dialects simultaneously. This is the strongest architectural idea in the design.

### 1.2 Core class map (`@spinajs/orm`)

| Area | Classes | Responsibility |
|---|---|---|
| Orchestration | `Orm` (orm.ts) | AsyncService: creates connections from config, discovers models/migrations from DI (`__models__`, `__migrations__`), runs startup migrations, loads table info, wires relations, applies static mixins |
| Driver contract | `OrmDriver` (driver.ts) | Abstract: `execute`, `connect`, `disconnect`, `ping`, `tableInfo`, `transaction`, `supportedFeatures`; provides builder factories (`select()`, `insert()`, …) bound to its container |
| Model layer | `ModelBase`, `MODEL_STATIC_MIXINS`, `MODEL_PROXY_HANDLER` (model.ts) | Active-record base. Instances are wrapped in a `Proxy` that tracks dirty columns. Static API (`where`, `get`, `insert`, …) is stubbed with `throw` and replaced at `Orm.resolve()` time by mixins |
| Metadata | decorators.ts, descriptor.ts | Decorators (`@Model`, `@Connection`, `@Primary`, `@BelongsTo`, `@HasMany`, `@HasManyToMany`, `@CreatedAt`, …) write an `IModelDescriptor` into reflect-metadata keyed *per class name* to survive inheritance; `extractModelDescriptorInherited` collapses the constructor chain base-first |
| Query building | `Builder` → `QueryBuilder` → `SelectQueryBuilder` / `InsertQueryBuilder` / `UpdateQueryBuilder` / `DeleteQueryBuilder` + DDL builders (builders.ts) | Builders are **thenables** (custom `then()`), composed from `WhereBuilder`/`LimitBuilder`/`OrderByBuilder`/`ColumnsBuilder`/`JoinBuilder`/… via `typescript-mix` `@use` declaration merging |
| Statements | statements.ts (abstract) → orm-sql/statements.ts (concrete) | Each WHERE/IN/BETWEEN/JOIN/column fragment is a DI-resolved statement object with `build(): {Statements, Bindings}` |
| Relations (query side) | `BelongsToRelation`, `OneToManyRelation`, `ManyToManyRelation`, `BelongsToRecursiveRelation`, `QueryRelation`, `VirtualRelation` (relations.ts) | Created by `SelectQueryBuilder.populate()`; belongs-to merges a LEFT JOIN into the parent query, has-many/many-to-many register middlewares that run **separate queries** after the parent resolves |
| Relations (data side) | `SingleRelation`, `OneToManyRelationList`, `ManyToManyRelationList`, `ManyQueryRelationList` (relation-objects.ts) | Array-like containers on model instances with `populate/sync/update/set/remove/diff/intersection` |
| Middlewares | middlewares.ts, discrimination-middleware.ts | `IBuilderMiddleware` hooks: `afterQuery` (raw rows), `modelCreation` (row → instance, used by discrimination map / single-table inheritance), `afterHydration` (async eager loading) |
| Hydration | hydrators.ts (`DbPropertyHydrator`, `NonDbPropertyHydrator`, `OneToMany/OneToOne/JunctionModel` hydrators) | Row → model, applying per-column `Converter.fromDB` |
| Dehydration | dehydrators.ts, converters.ts (`StandardModelToSqlConverter`) | Model → row for insert/update, applying `Converter.toDB`, FK columns written from populated relations |
| Migrations | `OrmMigration`, `Orm.migrateUp/migrateDown` | Class-name-encoded timestamps (`name_yyyy_MM_dd_HH_mm_ss`), tracked in `spinajs_migration` table, optional per-migration transactions |

### 1.3 Query lifecycle

```
Model.where(...)                        static mixin
  └─ createQuery(model, SelectQueryBuilder)
       resolves builder from the connection's child container,
       attaches DiscriminationMapMiddleware, binds query scopes
  └─ .populate('Relation')              creates IOrmRelation, may mutate query (belongs-to)
  └─ await builder                      Builder.then()
       ├─ driver.execute(builder)
       │    └─ builder.toDB()           dialect compiler → { expression, bindings }
       │         └─ relations compiled here (side effect in SqlSelectQueryCompiler.compile)
       │    └─ executeOnDb(sql, bindings, QueryContext)   mysql pool / tx connection
       ├─ middleware.afterQuery(rows)
       ├─ per row: middleware.modelCreation(row) (reverse order, first non-null)
       │            else __orm_model_factory__ → hydrate → IsDirty = false
       └─ Promise.all(middleware.afterHydration(models))  ← eager has-many /
                                                             many-to-many loads
```

Value conversion happens in two places: statement build time for WHERE bindings (`tryConvertValue`, converter lookup by JS constructor name in `__orm_db_value_converters__`) and dehydration time for insert/update values.

### 1.4 Transactions

`OrmDriver.transaction(queriesOrCallback)` returns an `ITransaction { commit, rollback }`. The MySQL implementation ([orm-mysql/src/index.ts:246](../packages/orm-mysql/src/index.ts#L246)) checks out a dedicated pooled connection, runs the work inside an `AsyncLocalStorage` scope so nested `executeOnDb` calls route to that connection, and **leaves commit/rollback to the caller**.

---

## 2. Confirmed bugs

Ordered by severity. Line numbers refer to the current working tree.

### Critical — wrong results or data loss on mainline paths

**B1. `migrateDown()` never rolls back an applied migration** — [orm/src/orm.ts:477-485](../packages/orm/src/orm.ts#L477-L485) · CONFIRMED
`executeAvaibleMigrations` is shared by up and down and gates the callback on `if (!exists)` — i.e. *the migration is NOT recorded in the migration table*. That is correct for up, and exactly inverted for down: an applied (recorded) migration is skipped, while a never-applied migration gets its `down()` executed (and then a `DELETE` against a row that doesn't exist). The test that should catch this ([orm/test/migration.test.ts:163-165](../packages/orm/test/migration.test.ts#L163-L165)) asserts nothing — `expect(spy1.calledAfter(spy2));` is missing `.to.be.true`, and the mocked select returns no rows, so `!exists` is true and the test passes for the wrong reason.

**B2. One boolean operator per WHERE clause — `orWhere` retroactively rewrites the whole query** — [orm/src/builders.ts:846-854](../packages/orm/src/builders.ts#L846-L854) + [orm-sql/src/compilers.ts:217](../packages/orm-sql/src/compilers.ts#L217) · CONFIRMED
`orWhere`/`andWhere` set a single builder-level `_boolean`; the compiler then joins **all** statements with that one operator: `where.join(\` ${builder.Op.toUpperCase()} \`)`. Consequences:
- `q.where(a).where(b).orWhere(c)` compiles to `a OR b OR c`, not `(a AND b) OR c`.
- `q.orWhere(a).andWhere(b)` silently reverts everything to AND.
- Filters intended as AND-restrictions can become OR-expansions — a data-exposure class of bug (e.g. a tenant filter OR'ed away).
The only correct way to mix booleans is nested function where's, which the API does not enforce or document.

**B3. Static `Model.count()` returns `undefined`** — [orm/src/model.ts:1155-1167](../packages/orm/src/model.ts#L1155-L1167) · CONFIRMED (by code-path trace; zero test coverage)
The mixin does `await (await query.asRaw<{count}>()).count`. `asRaw()` resolves to the **raw row array** (`[{count: N}]`), not a single row — `_first` is never set — so `.count` on an array is `undefined`. Every caller of `Model.count()` gets `undefined`. (`selectCount()` on the builder is correct because it calls `takeFirst()` first.)

**B4. `Model.destroy()` / empty-array where → unbounded DELETE/UPDATE** — [orm/src/model.ts:981-1002](../packages/orm/src/model.ts#L981-L1002) and [orm/src/builders.ts:859-867](../packages/orm/src/builders.ts#L859-L867) · CONFIRMED
Two composing hazards:
- `Model.destroy()` with `pks === undefined` skips the `whereIn` (the emptiness check tests `[undefined].length`, which is 1) and returns a DELETE — or for soft-delete models an UPDATE setting `DeletedAt` — **with no WHERE clause**. Awaiting it wipes/soft-deletes the entire table.
- `whereObject` silently drops keys whose value is an empty array (`where({ Id: [] })` → no condition at all). Standard SQL semantics for `IN ()` is *match nothing*; here it matches *everything*. `Model.destroy([])` throws, but `Model.destroy().where({ Id: ids })` with `ids = []` deletes every row.

**B5. `SingleRelation.remove()` always crashes** — [orm/src/relation-objects.ts:222-226](../packages/orm/src/relation-objects.ts#L222-L226) · CONFIRMED
```ts
public async remove() {
  this.detach();                  // sets this.Value = null
  await this.Value!.destroy();    // TypeError: cannot read 'destroy' of null
```
`detach()` nulls `Value` before the destroy call. The related row is never deleted; the caller gets a TypeError.

**B6. `where(col, op, null)` ignores the operator — `whereNot(col, null)` produces `IS NULL`** — [orm/src/builders.ts:828-838](../packages/orm/src/builders.ts#L828-L838) · CONFIRMED
In `_handleForThree` the first `if (sVal === null) return this.whereNull(c);` short-circuits before the operator is consulted; the following branch that would map to `whereNotNull` is dead code. `q.where('col', '!=', null)` and `q.whereNot('col', null)` both compile to `col IS NULL` — the exact opposite of the intent.

**B7. `orThrow()` builds the error from the factory but never throws it** — [orm/src/builders.ts:303-315](../packages/orm/src/builders.ts#L303-L315) · CONFIRMED
```ts
if (typeof error === 'function') {
  error = error((this as ...).toDB());   // assigned, never thrown
} else
  throw error;
```
With an error-factory argument (the recommended form, since it embeds the compiled SQL), `orThrow` on an empty result **returns the empty result instead of throwing**. `firstOrThrow`/`firstOrFail` have the correct logic; only `orThrow` is broken.

### High — crashes or wrong behavior in commonly reachable paths

**B8. Builder middleware array is reversed in place per row** — [orm/src/builders.ts:96](../packages/orm/src/builders.ts#L96) · CONFIRMED
`for (const middleware of this._middlewares.reverse())` inside the per-row `.map()`. `reverse()` mutates: with ≥2 middlewares and ≥2 rows, `modelCreation` order alternates row by row, and `afterHydration` (which iterates the same array afterwards) runs in whatever order the last row left it. Discrimination-map dispatch and relation hydration are both order-sensitive.

**B9. Broken thenable composition in `Builder.then()`** — [orm/src/builders.ts:73-149](../packages/orm/src/builders.ts#L73-L149) · CONFIRMED
`then()` calls `onfulfilled(result)` for its side effect but returns `undefined` (or a detached promise) to the chain:
- `builder.then(x => f(x)).then(g)` — `g` receives `undefined`, and `f`'s return value is lost. Single `await builder` works only because `await` supplies the resolve function directly.
- The `afterHydration` `Promise.all` chain (lines 112-127) is detached from the promise returned by `then()` — the outer promise can resolve before hydration middleware completes, and a rejection there routes through a different path than the documented one.
- Awaiting the same builder twice **executes the query twice** with already-mutated middleware state (see B8).

**B10. `whereExists('relation', callback)` crashes for belongs-to relations** — [orm/src/existsRelationHandlers.ts:46](../packages/orm/src/existsRelationHandlers.ts#L46) · CONFIRMED
`(builder as any).rightJoin(rel.TargetModel, callback.bind(relationName))` — `bind`'s first argument is `this`, so the callback executes with a **string** as `this`; its first `this.where(...)` throws `this.where is not a function`. (Compare the Many handler, which correctly uses `callback.apply(relQuery)`.)

**B11. fp helpers reject on success** — [orm/src/fp.ts:43,65,74,86,104](../packages/orm/src/fp.ts#L43) · CONFIRMED
All of `_update`, `_insert`, `_insertOrUpdate`, `_delete` reject when `res.LastInsertId <= 0 || res.RowsAffected <= 0`:
- `model.update()` on a **clean model** short-circuits with `{RowsAffected: 0, LastInsertId: 0}` ([model.ts:517-529](../packages/orm/src/model.ts#L517-L529)) → `_update`/`_insertOrUpdate` reject with `E_NO_ROWS_AFFECTED` even though nothing was wrong.
- Inserting a row whose PK is not auto-increment (UUID models) yields MySQL `insertId = 0` → `_insert` rejects after a successful insert.
- The MySQL driver omits `LastInsertId` for UPDATE/DELETE (`undefined <= 0` is `false`, so those pass by accident of coercion) — the check is wrong in both directions depending on driver.

**B12. Batch insert: column filter and value filter disagree on auto-increment PKs** — [orm-sql/src/compilers.ts:522-588](../packages/orm-sql/src/compilers.ts#L522-L588) · CONFIRMED
`columns()` drops the AI PK column only if **every** row lacks a value (`Values.every(...)`); `values()` drops the PK value **per row**. A mixed batch — some rows with explicit PK, some without — emits rows whose tuple arity doesn't match the column list: misaligned INSERT or a SQL error.

**B13. Upsert (`ON DUPLICATE KEY UPDATE`) binds only the first row, and nests binding arrays** — [orm-sql/src/compilers.ts:446-455](../packages/orm-sql/src/compilers.ts#L446-L455) · CONFIRMED
Update bindings are read from `parent.Values[0]` only — a multi-row insert with `onDuplicate().update([...])` applies row 0's values to every conflicting row (correct MySQL form is `VALUES(col)` / `new.col`). For `RawQuery` update columns, `c.Bindings` (an array) is pushed **nested** into the bindings list, shifting every subsequent placeholder.

**B14. `table.binary()` emits invalid DDL** — [orm-sql/src/compilers.ts:929](../packages/orm-sql/src/compilers.ts#L929) · CONFIRMED
`` `BINARY(${builder.Args[0] ?? 255}` `` — missing closing parenthesis; any migration using `binary()` fails at the database with a syntax error.

**B15. UUID columns: converter and DDL contradict each other, and round-trips change the value** — [orm/src/converters.ts:34-50](../packages/orm/src/converters.ts#L34-L50) + [orm/src/builders.ts:1985-1987](../packages/orm/src/builders.ts#L1985-L1987) · CONFIRMED
- `@Uuid` columns are initialized with `uuidv4()` (36-char dashed string), written to DB as a 16-byte `Buffer`, and read back by `fromDB` as a **32-char undashed hex string**. The identity of the key changes across a save/load cycle — equality checks against the original value fail.
- `fromDB(value)` crashes on NULL (`value.toString('hex')` with no guard).
- Meanwhile `TableQueryBuilder.uuid()` creates `VARCHAR(36)`, not `BINARY(16)` — the schema helper and the converter target different storage formats.

**B16. `DateTime` handling: `undefined` silently persists the epoch; timezone drift** — [orm-sql/src/converters.ts:128-130,158,185](../packages/orm-sql/src/converters.ts#L128-L130) · CONFIRMED
- `toDB(undefined)` returns `'1970-01-01 00:00:00'` — an unset field writes the epoch instead of NULL or an error.
- `toDB` serializes with `toSQL({ includeOffset: false })` (wall-clock in the value's zone); `fromDB` parses with `DateTime.fromSQL` in the **system** zone. Round-trips are only correct when app zone == DB session zone; there is no UTC normalization anywhere.

**B17. mysql `tableInfo()` interpolates identifiers into SQL** — [orm-mysql/src/index.ts:199,214](../packages/orm-mysql/src/index.ts#L199) · CONFIRMED
`` SHOW FULL TABLES where \`Tables_in_${schema}\`='${name}' `` and `SHOW INDEXES FROM ${name}` — `schema`/`name` are spliced in raw (the first query even single-quotes `name` without escaping). Also, when `Options.Database` is unset, the first query becomes `Tables_in_undefined` and errors, so `tableInfo` requires a configured Database even though the parameter is optional.

### Medium

**B18. `SelectQueryBuilder.clone()` drops group-by (and relations/middlewares)** — [orm/src/builders.ts:1070-1101](../packages/orm/src/builders.ts#L1070-L1101) · CONFIRMED
`clone()` copies columns, joins, where statements, limit, sort, CTE — but not `_groupStatements`, `_relations`, or `_middlewares`. `orm-api` clones queries for count-pagination; a grouped query silently loses its GROUP BY in the clone.

**B19. `toDB()` is not idempotent** — [orm-sql/src/statements.ts:64-65](../packages/orm-sql/src/statements.ts#L64-L65), [orm-sql/src/compilers.ts (SqlSelectQueryCompiler.compile)](../packages/orm-sql/src/compilers.ts) · CONFIRMED
`SqlWithRecursiveStatement.build()` pushes a join statement into the **shared** builder's `JoinStatements`; `SqlSelectQueryCompiler.compile()` calls `r.compile()` on relations as a side effect. Compiling a recursive query twice (e.g. `toDB()` for logging, then `await`) duplicates joins.

**B20. `OneToManyRelationList.update()` computes the dirty set before assigning foreign keys** — [orm/src/relation-objects.ts:528-537](../packages/orm/src/relation-objects.ts#L528-L537) · CONFIRMED
`const dirty = this.filter(...)` runs first; the subsequent FK assignment (`d[ForeignKey] = Owner.PrimaryKeyValue`) marks previously-clean models dirty — but they are already excluded from `dirty` and never persisted. A clean child moved to a new owner keeps its old FK in the DB; a following `sync()` (`_dbDiff`) can then **delete it** as "not belonging" to the new owner. Additionally the dirty filter tests `PrimaryKeyValue === null`, but fresh models have `undefined` PKs (`setDefaults` uses the column's `DefaultValue`), so `IsDirty` is the only thing catching new models.

**B21. `MetadataRelation.delete()` hardcodes the `user_id` column** — [orm/src/metadata.ts:82-85](../packages/orm/src/metadata.ts#L82-L85) · CONFIRMED
`.where({ Key: k, user_id: this.Owner.PrimaryKeyValue })` — works only when the owner FK column is literally `user_id`; any other metadata relation deletes nothing or errors. Should be `this.Relation.ForeignKey`. Also `getType(null)` returns `'json'` (`typeof null === 'object'`), so null metadata values serialize as JSON.

**B22. `@BelongsTo` default primary key comes from the wrong model** — [orm/src/decorators.ts:321-335](../packages/orm/src/decorators.ts#L321-L335) · CONFIRMED
`const targetModelDesc = extractModelDescriptor(target)` extracts the **source** class's descriptor (the variable name lies), so the relation's default `PrimaryKey` is the source model's PK. It only works because most models name their PK identically (`Id`); a target with a differently-named PK joins on the wrong column unless the user passes `primaryKey` explicitly.

**B23. `extractModelDescriptor` throws on undecorated classes** — [orm/src/descriptor.ts:92-94](../packages/orm/src/descriptor.ts#L92-L94) · CONFIRMED
`Reflect.getMetadata(...)` returns `undefined` for a class with no ORM metadata; `metadata[target.name]` then throws `TypeError` instead of returning `null` (the inherited variant guards; this one doesn't). Any code path that probes a non-model class gets a crash instead of a clean "no descriptor" result.

**B24. Transaction API: no auto-commit, connection leak on forgotten commit, double-release on commit failure** — [orm-mysql/src/index.ts:246-322](../packages/orm-mysql/src/index.ts#L246-L322) · CONFIRMED
After the callback succeeds, the transaction stays open and the pooled connection stays checked out until the caller invokes `commit()`. `Model.transaction(cb)` ([model.ts:1169-1172](../packages/orm/src/model.ts#L1169-L1172)) returns that `ITransaction` — a caller who treats the callback form as self-committing (the common ORM convention) leaks a connection per call and the pool eventually starves. If `commit()` fails, it rolls back and releases; a caller who then calls `rollback()` releases the same connection twice.

**B25. Every model instance from queries is double-proxied** — [orm/src/model.ts:399-407,1175-1180](../packages/orm/src/model.ts#L1175-L1180) · CONFIRMED
`ModelBase`'s constructor returns `new Proxy(this, MODEL_PROXY_HANDLER)`; `_modelProxyFactory` wraps that proxy in another identical proxy. Every property write traverses two traps and pushes the dirty prop twice into `__dirty_props__` (the trap's `!==` guard is defeated because the inner proxy already applied the write before the outer trap re-checks — order makes one of the pushes survive). Wasteful and a subtle source of duplicated dirty tracking.

**B26. `refresh()` leaves the model dirty; `populate()` marks the owner dirty** — [orm/src/model.ts:621-629](../packages/orm/src/model.ts#L621-L629), [orm/src/relation-objects.ts:493-509](../packages/orm/src/relation-objects.ts#L493-L509) · CONFIRMED
`refresh()` copies columns through the proxy, so a freshly-refreshed model reports `IsDirty === true` with every column in `__dirty_props__` — a following `update()` rewrites the entire row. `OneToManyRelationList.populate()` routes results through `Owner.attach(...)`, which sets `Owner.IsDirty = true` as a side effect of a read operation. `attach()` also pushes the child into **every** relation whose `TargetModel` name matches — a model with two relations to the same target gets the row in both.

### Low / smells

- **`SqlQueryCompiler` null guard is dead code** — [orm-sql/src/compilers.ts:35](../packages/orm-sql/src/compilers.ts#L35): `if (_builder === null && _builder === undefined)` — always false; should be `||`. CONFIRMED (harmless — DI never passes null today).
- **DDL string values unescaped** — [orm-sql/src/compilers.ts:918,928,951-956,1010](../packages/orm-sql/src/compilers.ts#L918): SET/ENUM members, `COMMENT`, `CHARACTER SET`, `COLLATE`, and string `DEFAULT` are single-quoted with no escaping; a value containing `'` breaks the migration. CONFIRMED.
- **`DbPropertyHydrator` skips a legitimate PK of `0`** — [orm/src/hydrators.ts:25](../packages/orm/src/hydrators.ts#L25): `!values[k]` is true for `0`. PLAUSIBLE.
- **One-to-one hydrator's "all columns null" heuristic** — [orm/src/hydrators.ts:101](../packages/orm/src/hydrators.ts#L101): a joined row whose selected columns are all genuinely NULL is treated as "no relation". PLAUSIBLE.
- **Empty string treated as null** — [orm/src/converters.ts:128](../packages/orm/src/converters.ts#L128) and [dehydrators.ts:22](../packages/orm/src/dehydrators.ts#L22): `val === ''` fails NOT NULL validation; you cannot store an intentional empty string in a non-nullable text column. CONFIRMED.
- **Unguarded `.Value` access** — [orm/src/converters.ts:136](../packages/orm/src/converters.ts#L136), [dehydrators.ts:57](../packages/orm/src/dehydrators.ts#L57): if a One-relation property was overwritten with null/undefined, dehydration crashes. PLAUSIBLE.
- **`BelongsToRelationRecursiveMiddleware` unguarded `find(...)!` dereference** — [orm/src/middlewares.ts:132](../packages/orm/src/middlewares.ts#L132). PLAUSIBLE.
- **`reloadTableInfo` crashes on columns without `NativeType`** — [orm/src/orm.ts:198](../packages/orm/src/orm.ts#L198): decorator-only columns (e.g. `@Ignore` stubs) have `NativeType: ''` from `_prepareColumnDesc`, which is fine, but merged columns that never got DB info and lack the field entirely would throw on `.toLocaleLowerCase()`. PLAUSIBLE.
- **`descriptor.ts` merge treats `0`/`false` as empty** — [orm/src/descriptor.ts:61](../packages/orm/src/descriptor.ts#L61): `_.isEmpty` on primitives is always `true`; currently no top-level descriptor field is boolean/number, so latent only. CONFIRMED-latent.
- **`attach()` relies on switch fallthrough** (Many → ManyToMany) with no comment — [orm/src/model.ts:437-446](../packages/orm/src/model.ts#L437-L446). Works today, one reordering away from breaking.
- **`Object.assign(d)` single-arg no-op** — [orm/src/middlewares.ts:277](../packages/orm/src/middlewares.ts#L277): intended clone, actually aliases and mutates the original row.
- **Timer label double-prefix** — [orm-mysql/src/index.ts:38-39](../packages/orm-mysql/src/index.ts#L38-L39): `query-query-N` (cosmetic).

---

## 3. Architectural concerns

**A1. The thenable builder is the root of a bug cluster.** Implementing `PromiseLike` by hand on a stateful, mutable object produces B3, B8, B9, B19: re-awaiting re-executes, mid-chain values are lost, and compile/execute side effects accumulate on the builder. A conventional `execute(): Promise<T>` (keeping `then` as a thin delegate to a memoized execution promise) would eliminate the whole class.

**A2. WHERE boolean model is structurally wrong** (B2). Boolean connectors belong on statements (as in Knex: each statement stores its own `and`/`or`), not on the builder. This needs a per-statement `Op` captured at push time; the compiler then joins pairwise.

**A3. Identifier handling is raw string interpolation, systemically.** Table names, aliases, column names, join keys, ON-clause fragments (`orm-sql/statements.ts` `_columnWrap`, `SqlJoinStatement`, `SqlTableAliasCompiler`, the exists handlers' `RawQuery` fragments, foreign-key DDL with *no* quoting at all) are all template-spliced with no backtick escaping. Model-bound WHERE columns are validated against the descriptor ([orm/src/statements.ts:163](../packages/orm/src/statements.ts#L163)) which mitigates injection for those, but `order()`, raw joins, schema names, and everything DDL are unvalidated. One `escapeIdentifier()` helper used everywhere would close this. Note also the backtick dialect is hardcoded in the *shared* `orm-sql` layer, which `orm-mssql` inherits.

**A4. Static API is stubbed with `throw` and patched at runtime.** All static model methods throw `Not implemented` until `Orm.resolve()` runs `applyModelMixins()`. Models are unusable (with runtime, not compile-time errors) before ORM bootstrap, mixins are `bind`-copied onto every class, and the real implementations live in an object literal with weaker typing than the stubs — which is precisely where B3 (broken `count`) survived unnoticed. Descriptor-driven static helpers or a base-class generic implementation would keep one source of truth.

**A5. Side-effectful reads.** `populate()` via relation lists marks the owner dirty (B26); `where('a.b', v)` and `order('a.b')` implicitly call `populate()` on the relation — a filter expression that silently changes what gets fetched and mutates builder state. Surprising-action-at-a-distance; filtering by a related column should use a join/exists, not force eager loading.

**A6. Dirty tracking is half-inside, half-outside the model.** A Proxy trap, a private `__dirty_props__` array accessed by other classes via `(as any)` "HACK" comments (`SingleRelation.attach`, `ModelBase.attach`), plus double-proxying (B25). Encapsulating dirty state behind model methods (`markDirty(prop)`) would remove the hacks and the double proxy.

**A7. Transactions are driver-level, not ORM-level.** There is no unit-of-work: `model.insert()/update()` inside a transaction works only because of `AsyncLocalStorage` in the MySQL driver — a driver-specific mechanism that the abstract `OrmDriver` contract doesn't require (other drivers may silently run "transactional" statements on the pool). The commit-is-manual convention (B24) contradicts the callback API shape users expect. Recommend: `transaction(cb)` auto-commits on callback success and rolls back on throw, with the explicit `begin/commit` object as the low-level alternative — and make the tx-context propagation part of the `OrmDriver` contract.

**A8. Middleware pipeline conflates concerns.** `IBuilderMiddleware` handles row transformation, model instantiation policy, and async eager loading in one interface, with order dependencies (reverse iteration for `modelCreation`), a known duplicate-registration bug worked around by `_.uniqBy` ([orm/src/middlewares.ts:262-266](../packages/orm/src/middlewares.ts#L262-L266)), and state merged across builders (`mergeRelations` concatenates middleware arrays). Consider separating "hydration strategy" from "post-load loaders" and making the pipeline immutable per execution.

**A9. Name-based lookups everywhere.** Models are found by class name (`wireRelations`, `createQuery`, `ManyToManyRelation`), junction relation properties are found by target-model name, relations matched case-insensitively "for backward compatibility". Two models with the same class name in different connections, or a minified bundle, break these silently. Prefer identity (constructor references / symbols) with names only for diagnostics.

**A10. `typescript-mix` `@use` mixins.** Builder capabilities are merged by declaration-merging interfaces plus runtime prototype copying; every mixed-in field must also be redeclared on the host class (`SelectQueryBuilder` re-declares `_statements`, `_limit`, `_sort`, …). Forgetting one yields `undefined`-state bugs invisible to the compiler. Composition (builder holds a `WhereClause` object) would be type-safe.

---

## 4. Missing features (vs. Knex / TypeORM / MikroORM class)

Query layer:
- **Multi-column ORDER BY** — `_sort` is a single `{column, order}`; a second `order()` call overwrites the first. No `NULLS FIRST/LAST`, no ordering by expression with bindings.
- **Set operations** — no `UNION` / `INTERSECT` / `EXCEPT` (UNION ALL exists only hardcoded inside the recursive CTE).
- **General CTEs** — only the single fixed-name recursive CTE; no `WITH`, no multiple/named CTEs.
- **Window functions** — none.
- **Locking clauses** — no `FOR UPDATE` / `FOR SHARE` / `SKIP LOCKED`; pessimistic locking is impossible.
- **HAVING with bindings via `groupBy(RawQuery)`** — `SqlGroupByCompiler` returns empty bindings, dropping any raw-query bindings.
- **Sub-query select / `whereIn(column, subquery)`** — `whereIn` accepts only value arrays.

Model / persistence layer:
- **Soft-delete read filtering** — the `@SoftDelete()` doc promises rows are "hidden from select result by default", but no select path adds `DeletedAt IS NULL`. Deleted rows appear in every query unless manually filtered. Either implement a default scope (with `withDeleted()` escape hatch) or fix the doc.
- **Composite primary keys** — `PrimaryKey` is a single string throughout.
- **Optimistic locking** — no version column support.
- **RETURNING support/emulation** — inserts depend on `insertId`; UUID/string-PK models get nothing back (and B11 shows the code assumes AI semantics).
- **Nested transactions / savepoints, isolation levels** — `transaction()` has no options.
- **Identity map / per-request caching** — two queries returning the same row yield two disconnected instances.
- **Cursor pagination** — only `take/skip`.
- **Batch chunking** — `insert(array)` builds one statement regardless of size; no chunked writes or streaming reads (`pool.query` buffers everything).
- **Connection resilience** — one `getConnection` health check at startup; no reconnect/backoff policy, no pool metrics.
- **Migration tooling** — no dry-run, no schema diffing, no lock against concurrent migrators (two instances booting simultaneously can both run the same migration; the unique constraint on `Migration` only makes the loser crash mid-transaction, and only if per-migration transactions are enabled).
- **Prepared statement reuse** — every execution is `pool.query`; no `execute`/prepared cache.

Test-suite gaps worth fixing alongside:
- Assertion-less expects in [orm/test/migration.test.ts:149-151,163-165](../packages/orm/test/migration.test.ts#L149-L151) (`expect(spy.calledOnce);` — missing `.to.be.true`), which is exactly why B1 survives.
- No coverage at all for: static `Model.count()` (B3), `orThrow` (B7), `whereExists` with callback on One-relations (B10), mixed-PK batch inserts (B12), `binary()` DDL (B14), `SingleRelation.remove()` (B5).

---

## 5. Suggested priorities

1. **Correctness of destructive paths:** B1 (migrateDown), B4 (unbounded destroy / empty-IN), B24 (transaction leak) — these damage data or production stability.
2. **Silent wrong results:** B2 (WHERE boolean), B6 (null-operator), B3 (`count`), B20 (relation sync losing children).
3. **Crash fixes** (small, mechanical): B5, B7, B10, B14, B23, plus the `.Value`/UUID-null guards.
4. **Architectural refactors** in order of leverage: A1 (execute-once promise) → A2 (per-statement boolean) → A3 (identifier escaping helper) → A7 (auto-commit transaction API).
5. Turn the assertion-less tests into real assertions before touching migration code, so B1's fix is provable.

---

## 6. Changelog — iteration 1 (branch `orm-fixes-1`)

Three commits. Every fix landed with a red-first test unless noted. Test-suite deltas from the pre-work baseline: `orm` 89→113 passing, `orm-sql` 119→131, `orm-sqlite` 41→42 — all with the **same** pre-existing failures unchanged (orm 2, orm-sql 7, orm-sqlite 8; none in scope). orm-mysql not run (no live DB); its one touched path (B17) is compile-verified.

**Phase A+B — `d27e69f6a` (test repair + 12 mechanical crash fixes):**
Repaired 6 vacuous `expect(...)` assertions in `migration.test.ts`. Fixed: B5 (`SingleRelation.remove` null-deref), B7 (`orThrow` not throwing), B10 (`whereExists` belongs-to callback crash), B14 (`binary()` DDL missing paren), B23 (`extractModelDescriptor` throw on undecorated class), B15a (`UuidConverter.fromDB` null crash), B21 (metadata `delete()` hardcoded `user_id`; `getType(null)`), B25 (double-proxy), B26a (`refresh()` left model dirty), the `.Value` guards, the `&&`→`||` dead guard, and the PK-of-0 hydration skip.

**Phase C — `198d2f596` (behavior-changing fixes, correct semantics, no compat flags):**
B1 (migrateDown gate split by direction), B3 (`count()` returned undefined), B6 (null-operator wheres), B4a (`destroy()` no-args now throws), B4b (empty-array where → `FALSE`), B11 (fp helpers no longer reject on success), B16a (datetime `toDB(undefined)` → null), B15b (UUID canonical dashed round-trip + `uuid()` DDL → `BINARY(16)`), B20 (relation `update()` losing re-parented children), B22 (`@BelongsTo` default PK from wrong model), B17 (mysql `tableInfo` SQL-injection/interpolation).

**Phase D — `e687102a7` (small features):**
Multi-column ORDER BY (`OrderByBuilder` accumulates; `getSort()` kept for dialect back-compat, `getSorts()` added). Default soft-delete read filtering — `createQuery` adds `DeletedAt IS NULL` for `@SoftDelete` models (guarded on the column being reflected), with `SelectQueryBuilder.withDeleted()` to opt out; tested end-to-end in orm-sqlite.

### Breaking / behavior changes (callers may rely on old behavior)
- **`Model.destroy()` with no args now throws** — full-table clears must use `truncate()`.
- **Empty-array conditions match nothing** — `where({ Id: [] })` / `whereIn('Id', [])` compile to `FALSE` (was: condition dropped → matched everything).
- **`whereNot(col, null)` / `where(col, '!=', null)` → `IS NOT NULL`** (was: `IS NULL`).
- **`migrateDown()` now actually rolls back applied migrations** (was: inverted, ran `down()` only for unapplied ones).
- **fp `_update`/`_insertOrUpdate` resolve on no-op updates** and none of the fp helpers reject on `LastInsertId <= 0` anymore.
- **UUID reads return canonical dashed form**; `uuid()` DDL emits `BINARY(16)` not `VARCHAR(36)` (new migrations only).
- **`@SoftDelete` models exclude soft-deleted rows by default** — pass `.withDeleted()` to include them. Downstream packages (`orm-api`, `orm-http`, `orm-mssql`) compile clean against the interface additions; their runtime suites were not exercised here.

### Deferred to iteration 2+ (separate plan & approval)
B2 (per-statement WHERE boolean), B8/B9/B19 (execution-model refactor), B24 (transaction auto-commit + contract), B12/B13 (batch-insert/upsert bindings), B18 (`clone()` completeness), A3 (identifier escaping), plus feature gaps: locking clauses, composite PKs, savepoints, RETURNING emulation.

---

## 7. Changelog — iteration 2 (branch `orm-fixes-2`, "safe correctness tier")

Four commits off the `orm-fixes-1` tip, red-first tests throughout. Suite deltas from the iteration-1 end state: `orm` 113 pass (unchanged — only `builders.ts` touched, no new orm tests beyond B18), `orm-sql` 131→146 pass, `orm-sqlite` 42→43 pass — all with the **same** pre-existing failures (orm 2, orm-sql 7, orm-sqlite 8). orm-mysql and orm-mssql are compile-verified only (no live DB); `orm-api`/`orm-http` compile clean.

- **`ba20ee674` — B12/B13 (insert & upsert compiler):** multi-row insert column/value alignment (auto-increment PK column no longer desyncs from value tuples on mixed batches); `ON DUPLICATE KEY UPDATE` now emits `col = VALUES(col)` instead of binding only row 0, and RawQuery update bindings are flattened (were nested).
- **`ca91d3fb5` — B18 (`clone()` completeness):** `SelectQueryBuilder.clone()` now carries `_groupStatements` (cloned), `_relations`, and `_middlewares` — a cloned query no longer silently loses its GROUP BY (e.g. orm-api count-pagination) or populated relations.
- **`00a81987f` — B2 (per-statement WHERE/HAVING boolean):** the AND/OR connector is now stamped on each statement at push time instead of a single builder-level `Op` applied uniformly. The JOIN `ON`-clause builder was routed through the same logic.
- **`92ea0c596` — A3 (central identifier escaping):** added `escapeIdentifier` / `escapeStringLiteral` helpers (orm-sql) and routed table/column/alias/schema/FK-DDL identifiers and DDL string literals (SET/ENUM/COMMENT/CHARSET/COLLATE/DEFAULT) through them.

### Breaking / behavior changes
- **Mixed `andWhere`/`orWhere` now group per-statement** — `where(a).where(b).orWhere(c)` compiles to `a AND b OR c` (was: `a OR b OR c`, the last-set connector rewrote the whole clause). Any query mixing AND/OR may change generated SQL to the correct grouping.
- **Upsert binds every conflicting row** via `VALUES(col)` rather than row 0's values — multi-row `insertOrUpdate` semantics change.
- **Foreign-key DDL is now backtick-quoted** (was unquoted); identifiers containing a backtick are now escaped rather than breaking the statement.

### A3 is intentionally partial (byte-identity constraint)
To keep generated SQL byte-identical for normal identifiers (protecting the existing assertion suites), several **descriptor-sourced** sites that existing tests assert unquoted were deliberately left unescaped: JOIN `ON` key columns (alias qualifiers *are* escaped), the recursive-CTE column list, `DROP COLUMN` names, and the table-history/event compilers. These take identifiers from validated model descriptors, not user input, so injection risk is low; the injection-reachable high-risk sites (previously-unquoted FK DDL, table/alias/schema names, DDL string literals) are all covered. orm-mssql was routed through the shared backtick escaper rather than given a true `[bracket]` override (a bracket dialect is now a one-function change). A full sweep of the remaining sites is follow-up work.

### Still deferred to iteration 3+ (pre-decided semantics)
- **Execution-model refactor (A1/B8/B9/B19)** — memoized execute-once promise (**decided: second await returns the cached result; `toDB()` idempotent**), remove in-place `_middlewares.reverse()` and compile side-effects.
- **Transaction API (B24)** — **decided: `transaction(callback)` auto-commits on success, rolls back on throw; keep explicit begin/commit as the low-level API**; formalize tx-context in the `OrmDriver` contract; fix double-release.
- **Tier-4 features** — `FOR UPDATE`/`FOR SHARE` locking, composite primary keys, savepoints, RETURNING emulation (dead `.returning()` API exists at `builders.ts:1555`).
