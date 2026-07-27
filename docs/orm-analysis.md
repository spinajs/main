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

---

## 8. Changelog — branch `orm-foundation` (shared groundwork)

Forked from `orm-fixes-2` @ `be0ac3812`. Implements F1, F2 and F5 of
[the foundation spec](superpowers/specs/2026-07-25-orm-foundation-design.md); F3 and F4 had
already landed on `orm-fixes-2` and were verified un-regressed rather than redone.

Suite deltas, all against a baseline measured on this branch before any source change and with
the **same** pre-existing failures throughout (orm 2, orm-sql 7, orm-sqlite 8, orm-mssql 4 —
mssql still needs a live server this machine does not have):

| Package | Baseline | After | New tests |
| --- | --- | --- | --- |
| `orm` | 113 pass / 2 fail | 120 pass / 2 fail | +7 driver-contract |
| `orm-sql` | 146 pass / 7 fail | 150 pass / 7 fail | +4 execution-model |
| `orm-sqlite` | 43 pass / 8 fail | 43 pass / 8 fail | +7 in a new integration suite |
| `orm-mysql` (live MySQL 8.4.10) | 16 pass / 4 fail | 23 pass / 4 fail | +7 stubbed-pool unit |
| `orm-mysql` integration (live) | n/a | **9 pass / 0 fail** | +9 transaction-contract |
| `orm-mssql` | 0 pass / 4 fail | 0 pass / 4 fail | — (compile-verified only) |

The `orm-mysql` rows were re-measured on 2026-07-26 against the docker-compose MySQL, replacing
the original figures which were taken with no server running and so recorded every server-
dependent test as a failure. Both `orm-mysql` columns share the same four pre-existing failures
(two `MySql transactions` hooks, two `MySql cross-schema whereExists` hooks).

- **`9fd6d513d` — F1 / B9 (execute-once builder).** `Builder.then()` was the entire execution
  engine *and* invoked `onfulfilled` for its side effect, discarding whatever the callback
  returned. The engine moved into `protected _run()`, which returns its values; `execute()`
  memoizes `_run()`'s promise; `then()`/`catch()`/`finally()` are now delegates over a real
  promise chain. `SelectQueryBuilder` overrides `_run()` (not `execute()`) so the `takeFirst()`
  unwrapping and `beforeQueryExecution` land inside the memo.
- **`563016b12` — F1 / B8, B19 (immutable middleware pipeline).** `_run()` snapshots
  `_middlewares` once per execution and derives the `modelCreation` order from a copy;
  `Array.prototype.reverse()` is never called on the live array again. `QueryRelation.compile()`
  and `VirtualRelation.compile()` gained the `_compiled` guard the other relation kinds already
  had (`_compiled` moved up to `OrmRelation`), which is what made `toDB()` non-idempotent.
- **`c1a0f7e79` — F2 / B24 (transaction contract).** `OrmDriver.transaction()` is now a concrete
  template method over seven abstract primitives (`_begin`, `_commit`, `_rollback`, `_savepoint`,
  `_releaseSavepoint`, `_rollbackToSavepoint`, `_dispose`). It commits on resolve, rolls back on
  throw, and disposes in a `finally` so the connection is released exactly once on every path.
  The `AsyncLocalStorage` transaction context moved from the MySQL driver into the abstract base,
  so ambient-connection propagation is part of the contract; `CurrentTransaction` exposes it.
- **`20e158a2e` / `a6f1c5597` / `f98c02b0f`** — MySQL, SQLite and MSSQL implement the primitives.
- **`1b3a603b6` — F5 (integration infrastructure).** Root `docker-compose.yml` (MySQL 8 on host
  port 3900, behind the `test` compose profile), `test:integration` scripts, and transaction
  integration suites for MySQL and SQLite.

### Breaking changes

1. **Re-awaiting a builder no longer re-executes it.** Execution is memoized per builder
   instance; the second `await` resolves with the first result. Call `.clone()` for a fresh run.
2. **`then()` now propagates callback return values.** `await qb.then((rows) => x)` resolves with
   `x`; it previously resolved with `undefined`. Code that relied on the old behaviour — for
   instance treating a `.then()` chain as fire-and-forget — will now see a real value. This also
   silently repairs `selectCount()`, which had been resolving `undefined`.
3. **`transaction(cb)` commits automatically and resolves with the callback's result.** It no
   longer resolves with an `ITransaction`. **Existing callers must drop their `.commit()` call** —
   `await (await driver.transaction(fn)).commit()` becomes `await driver.transaction(fn)`.
4. **The array-of-builders form of `transaction()` is removed.** `transaction([q1, q2])` no longer
   compiles; wrap the queries in a callback instead. The zero-argument form
   (`await driver.transaction()` returning a handle) is removed for the same reason.
5. **Nested `transaction()` calls create savepoints** instead of independent transactions. An
   inner block that throws now rolls back only its own work, and the enclosing transaction
   survives. Previously the inner call opened a second, unrelated transaction.
6. **`transaction(cb, { isolation })` rejects unsupported levels** rather than ignoring them.
   SQLite declares `SERIALIZABLE` only; MySQL and MSSQL declare all four.
7. **Custom `OrmDriver` subclasses must implement the seven transaction primitives.** They are
   abstract, so a driver that does not implement them will not compile. In-repo drivers
   (MySQL, SQLite, MSSQL, the Electron renderer bridge, and the test fakes) were all updated.
8. **`ModelBase.transaction()` is generic in its return type** — `Promise<R>` rather than
   `Promise<ITransaction>`.
9. **`packages/orm-mysql` and `packages/orm-sqlite` narrowed their `test` glob** from
   `test/**/*.test.ts` to `test/*.test.ts`, so `npm test` no longer sweeps `test/integration/`
   into the unit run. Integration specs run via `npm run test:integration`.

`ITransaction` itself is still exported and unchanged; nothing in the ORM produces one any more.

### Deferred, with reasons

- **The explicit `begin`/`commit`/`rollback` escape hatch** named in the spec was *not* added.
  The transaction primitives are `protected`, so there is no public low-level form. Building one
  that keeps the ambient-context guarantee would need `AsyncLocalStorage.enterWith()` and its own
  leak story; a half-working escape hatch is worse than none. No in-repo caller needs it.
- **MySQL integration suite now verified against a live server** (2026-07-26, MySQL 8.4.10 via
  `docker compose --profile test up -d mysql`): 9 passing, 0 failing. Its assertions are also
  mirrored at unit level against a stubbed `mysql2` pool in
  `packages/orm-mysql/test/transaction-unit.test.ts` (7 passing), including the
  release-exactly-once check that is the real proof of B24. Two defects surfaced only once the
  suite actually ran, both fixed here:
  - `docker-compose.yml` passed `--default-authentication-plugin=mysql_native_password` against
    image `mysql:8`. That tag now resolves to 8.4.x, which **removed** the variable, so the
    container crashlooped with `unknown variable`. The image is now pinned to `mysql:8.4` and the
    flag dropped — mysql2 3.x speaks `caching_sha2_password`, which is the production default
    anyway.
  - The integration config set `Migration.OnStartup: false` and migrated by hand in `before`.
    `Orm.resolve()` runs migrations *then* `reloadTableInfo()` unconditionally, and the MySQL
    driver **throws** `Table <db>.<name> does not exist` (`orm-mysql/src/index.ts:217`) where the
    SQLite driver returns `null` — so resolve() aborted before the suite could migrate. Set to
    `OnStartup: true`. **The underlying driver inconsistency is pre-existing and untouched by this
    branch**: on MySQL, an ORM configured with `OnStartup: false` cannot boot against a database
    whose model tables do not yet exist. Logged for `orm-infra`.
- **The reflective `clone()` guard test** (F4's optional leftover) was not added; F4 itself is
  done and un-regressed.
- **`_.uniqBy` workaround at `middlewares.ts:262-268`** was left in place. F1 makes the pipeline
  immutable *per execution*, but the root cause of duplicate registration is `orm-uow`'s.

---

## 9. Changelog — branch `orm-infra`

> The plan said to append this as "section 8"; section 8 is already `orm-foundation`, so it is 9.

### I1 — Per-statement WHERE/HAVING connector (landed earlier as `00a81987f`)

The AND/OR connector is stamped on each statement when it is pushed, instead of a single
builder-level flag that the compiler applied to every statement in scope. HAVING got the same
treatment, and the JOIN `ON` builder was routed through the same code.

**Before / after:**

| Chain | SQL before | SQL now |
| --- | --- | --- |
| `.where('a', 1).orWhere('b', 2).where('c', 3)` | `a = ? OR b = ? OR c = ?` | `a = ? OR b = ? AND c = ?` |
| `.where('a', 1).where('b', 2).orWhere('c', 3)` | `a = ? OR b = ? OR c = ?` | `a = ? AND b = ? OR c = ?` |
| `.where('a', 1).where('b', 2)` | `a = ? AND b = ?` | `a = ? AND b = ?` (unchanged) |
| `.orWhere('a', 1).orWhere('b', 2)` | `a = ? OR b = ?` | `a = ? OR b = ?` (unchanged) |

Pure-AND and pure-OR chains are unaffected. Only chains that mix the two change, and the new
result is the one every other builder (Knex, TypeORM) produces. The connector of the *first*
statement in a clause is discarded (`joinBuiltStatements`, `orm-sql/src/compilers.ts`), so a
leading `orWhere` never emits a dangling `WHERE OR`.

**Migration.** If you relied on a trailing `orWhere` turning the whole clause into a disjunction,
wrap the intended group explicitly:
`.where(function () { this.where('a', 1).where('b', 2); }).orWhere('c', 3)`.

**Consumer verification — `orm-http`.** Its DTO→WHERE translation is **not** affected, and this
was established by reading the translation code, not inferred from a clean compile:

- `packages/orm-http/src/builders.ts:150-221` (`SelectQueryBuilder.prototype.filter`) wraps the
  entire filter set in one explicit `this.andWhere(function () { ... })` group, so the group is
  isolated from anything else already on the query.
- Inside that group it applies `applyAnd` for **every** filter or `applyOr` for **every** filter,
  chosen once from `logicalOperator`. It never mixes the two in one chain — which is exactly and
  only the case whose SQL changed.
- The two direct `query.where(...)` calls (`src/index.ts:97`, `:117`) are single statements.

A regression suite pinning this SQL was added at `packages/orm-http/test/filters.test.ts`
(6 tests, all passing): the mixed chain, a leading `orWhere`, `filter()` in AND mode, `filter()`
in OR mode, a filter group AND-joined to an outer `where`, and the documented explicit-group
migration.

**Caveat — the pre-existing `orm-http` suite does not run in this worktree.** `npm test` in
`packages/orm-http` reports 0 passing / 2 failing: `Http orm tests > "before all" hook` dies with
`TypeError: Cannot read properties of undefined (reading 'get')` in
`packages/configuration/src/decorators.ts:27` while resolving `fsService`, and the `after all`
hook then fails with `No __file_provider_instance__ registered`. That is an HTTP/fs bootstrap
defect unrelated to the WHERE connector — it fails before any query is built. The new
`filters.test.ts` therefore boots only the ORM (SQLite, in-memory) and applies
`MODEL_STATIC_MIXINS` to its fixture model exactly as `src/index.ts:199-203` does in production,
so the real `filter()` path is exercised against a real SQL compiler.

### I2 — Composite primary keys

`IModelDescriptor.PrimaryKey` changed from `string` to `string[]`, and `ModelBase.PrimaryKeyName`
from `string` to `string[]`. `@Primary()` may now decorate more than one property of a model.
Every predicate that used to be built by hand now goes through one module,
`packages/orm/src/primary-keys.ts`.

**Breaking:**

- `descriptor.PrimaryKey` is an array. Read `descriptor.PrimaryKey[0]` for single-key models, or
  use the new `pkColumns(descriptor)` helper.
- `ModelBase.PrimaryKeyValue` returns a **tuple** for composite-key models and an unchanged scalar
  for single-key models. Its setter accepts a scalar, an array in key order, or an object keyed by
  column name.
- `IRelation.set(fn)` — the callback's second argument is now `string[]` instead of `string`, as
  are `Dataset.diff` / `Dataset.intersection`.
- `@Primary()` is **additive across inheritance**: a subclass cannot replace a base class's key,
  only extend it. Declare every key column on the concrete model. (`extractModelDescriptorInherited`
  de-duplicates, so an inherited `['Id']` does not become `['Id','Id']`.)
- Relations refuse to default their join column when the model has a composite key. `@BelongsTo`,
  `@HasMany`, `@HasManyToMany` and `@Historical` throw `InvalidOperation` unless the key is named
  explicitly (`@HasMany(Target, { primaryKey: 'TenantId', foreignKey: 'tenant_id' })`). A relation
  joins on exactly one column pair, so guessing which half of a composite key it meant is the kind
  of silent wrong answer this branch exists to remove.
- `orm-api`'s generic CRUD routes and `orm-http`'s `@FromModel` reject composite-key models — a
  single `:id` path segment cannot carry a composite key. Pass `queryField` to `@FromModel` to
  select one lookup column.

**Not breaking.** A one-element key compiles to exactly the SQL it did before: `WHERE `Id` = ?`,
`WHERE `Id` IN (?,?)`, `ORDER BY `Id` DESC`. No `AND` wrapper is introduced. This is asserted, not
assumed — `packages/orm-sql/test/primaryKeys.test.ts` pins the single-key SQL byte for byte.

**SQL shapes for composite keys:**

| Operation | SQL |
| --- | --- |
| `Model.get([1, 'a'])` | `WHERE ( `TenantId` = ? AND `Code` = ? )` |
| `Model.find([[1,'a'],[2,'b']])` | `WHERE ( ( `TenantId` = ? AND `Code` = ? ) OR ( `TenantId` = ? AND `Code` = ? ) )` |
| orphan delete | `WHERE ( ( `TenantId` != ? OR `Code` != ? ) AND ... )` |
| `_prepareOrderBy` | `ORDER BY `TenantId` DESC, `Code` DESC` |

**SQLite fixes carried by this work.** `PRAGMA table_info`'s `pk` column is a 1-based position
within the key, not a boolean, so `tableInfo` previously reported only the *first* column of a
composite key as primary and wrongly flagged it auto-increment. Composite keys now emit a
table-level `PRIMARY KEY (a,b)` constraint instead of an inline `PRIMARY KEY` per column, which
SQLite rejects outright; SQLite also cannot auto-increment a column inside a composite key, and the
DDL compiler now says so explicitly rather than emitting invalid SQL.

**MySQL fix carried by this work.** `MySqlOrmDriver.tableInfo` read
`INFORMATION_SCHEMA.COLUMNS` with no `ORDER BY`, so column order was whatever the server produced
that run — the same table came back as `(Code, TenantId)` in one run and `(TenantId, Code)` in the
next. Now ordered by `ORDINAL_POSITION`.

### I3 — RETURNING and generated keys

- `@Primary({ generated })` accepts `auto` (default, database identity — today's behaviour),
  `uuid` (generated client-side at construction, so the key is known before the insert), and
  `assigned` (caller supplies it; inserting without one throws with the column named).
- Driver insert results are now `IInsertResult { RowsAffected, LastInsertId, Returning }`.
  `LastInsertId` is 0 when the dialect reports no identity value.
- `ServerResponseMapper.read(response, pkNames?: string[])` — the second parameter changed from
  `string` to `string[]`, and `DbServerResponse` gained `RowsAffected` and `Returning`.
- `ISupportedFeature` gained `insertReturning: boolean` (SQLite true, MySQL and MSSQL false).
  **Any custom driver must add this field.**
- `ISupportedFeature` also gained the optional `insertIdIsFirstOfBatch?: boolean` — see below. It is
  optional and defaults to false, so an existing custom driver keeps compiling and simply opts out.
- `InsertQueryBuilder.returning(cols)` now **throws `NotSupported`** on drivers that cannot honour
  it, instead of silently doing nothing (which is what it did on MySQL and MSSQL for years).
- SQLite emits `RETURNING` on plain inserts, not only on the upsert path, and
  `QueryContext.InsertReturning` was added to route those statements through `Db.all`.

**Batch insert keys.** `Model.insert([a, b, c])` fills in every model's key, and where it cannot do
so correctly it now fills in nothing rather than guessing:

1. If the dialect returned `RETURNING` rows, they are authoritative and are applied in insert order.
   This is the SQLite path.
2. Otherwise, on a dialect whose reported identity value is the **first** of the statement's block
   (`insertIdIsFirstOfBatch`), the keys are `LastInsertId + index`. This is the MySQL path.
3. Otherwise nothing is assigned.

Case 2 is a documented InnoDB guarantee, not an optimistic assumption, and it was verified against a
live MySQL 8.4 with `innodb_autoinc_lock_mode = 2`: a 5-row `VALUES` insert reported
`LAST_INSERT_ID() = 1`, `ROW_COUNT() = 5` and produced ids `1,2,3,4,5`. InnoDB distinguishes a
*simple insert*, whose row count is known before execution — which every
`INSERT ... VALUES (…), (…)` is, and the only shape `InsertQueryBuilder` can build — from a *bulk
insert* (`INSERT … SELECT`), where it is not. For a simple insert it reserves one contiguous block
of N auto-increment values under a short mutex. The manual's "values may not be contiguous" caveat
is about bulk inserts and about mixed-mode inserts.

The backfill is refused whenever the positional mapping could break: a composite or non-`auto` key,
an `InsertBehaviour` other than `None` (IGNORE / REPLACE / ON DUPLICATE can skip or update rows), a
non-positive identity value, `RowsAffected !== rows.length`, or a batch in which any row already
carries a key (a mixed-mode insert — InnoDB only allocates for the rows that omitted one).

**MSSQL is deliberately excluded** from case 2 and is the narrow case that genuinely cannot be
backfilled: `SCOPE_IDENTITY()` reports the **last** identity generated in the scope, so there is no
first-of-block value to walk forward from. It reports `insertIdIsFirstOfBatch: false` and a
multi-row batch assigns nothing. Callers there must insert one at a time or re-select. SQLite sets
the same flag false (`sqlite3`'s `lastID` is likewise the last rowid) but never reaches case 2,
because it has RETURNING.

### I4 — Connection resilience, pool behaviour and telemetry

- `IDriverOptions.Pool` (`Min`, `Max`, `IdleTimeout`, `AcquireTimeout`) replaces the single
  `PoolLimit`, which is deprecated but still honoured as `Pool.Max` when `Pool.Max` is absent.
- `IDriverOptions.Resilience` (`HealthCheckInterval`, `MaxRetries`, `RetryDelay`, `MaxRetryDelay`)
  controls reconnect and health probing. Defaults: 30000 / 5 / 200 / 5000.
- Drivers expose `State: ConnectionState` (`disconnected` / `connecting` / `connected` /
  `degraded`) and log every transition.
- Transport failures (`ECONNRESET`, `PROTOCOL_CONNECTION_LOST`, mysql2 `fatal` errors, …) are
  retried with bounded exponential backoff after a reconnect. Query errors are **not** retried and
  propagate on the first attempt. Statements inside a transaction are never retried — replaying one
  statement of a lost transaction would apply it outside the transaction.
- The single startup `ping()` is replaced by a periodic probe (`startHealthCheck()` /
  `stopHealthCheck()`), started by `Orm` after a successful connect and stopped on `dispose()`. The
  timer is `unref()`ed and never holds the process open.
- Pool telemetry goes through a new `OrmMetricsSink` abstract seam in `@spinajs/orm` with a no-op
  default (`NullOrmMetricsSink`, registered in `bootstrap.ts`). `@spinajs/metrics` ships
  `PromOrmMetricsSink`; register it with `DI.register(PromOrmMetricsSink).as(OrmMetricsSink)`.
  Metrics: `orm_pool_size`, `orm_pool_in_use`, `orm_pool_waiting`, `orm_pool_acquire_seconds`,
  `orm_connection_state`, all labelled `connection`.
  **The dependency runs `@spinajs/metrics` → `@spinajs/orm`, never the other way**, because
  `@spinajs/metrics` depends on `@spinajs/http`; an ORM that depended on it would put the whole HTTP
  stack underneath every database connection. `@spinajs/http` does not depend on `@spinajs/orm`, so
  the graph stays acyclic.
  Publishing can never fail a query or a health probe: the sink lookup falls back to a discarding
  sink and `publishPoolMetrics()` swallows and traces.
- MySQL's `_executeOnDbOnce` now takes its pool connection explicitly instead of letting
  `Pool.query` acquire out of sight. That is what makes `orm_pool_acquire_seconds` a real number
  rather than always zero; the connection is released on every path including a synchronous throw,
  and a transaction's connection is never released mid-transaction.
- SQLite: write serialization is intended and documented. `Pool.Max > 1` on a file-backed SQLite
  connection opens `Max - 1` **read-only** handles that plain `SELECT`s round-robin across; writes,
  schema changes, upserts, RETURNING inserts and anything inside a transaction stay on the single
  writer handle. Ignored for `:memory:` and anonymous temporary databases, where each handle would
  open its own private database.

### Deferred, with reasons

- **`tableInfo`'s missing-table contract stays inconsistent between drivers.** MySQL throws
  `Table <db>.<name> does not exist` (`orm-mysql/src/index.ts`); SQLite returns `null`. Because
  `Orm.resolve()` migrates and then calls `reloadTableInfo()` unconditionally, a MySQL connection
  whose tables do not exist yet must be configured with `Migration.OnStartup: true` or resolve
  blows up. Both integration configs say so in a comment.

  This was a deliberate decision, not an oversight. Normalising it at the driver level would turn a
  loud misconfiguration into a silently empty model descriptor — precisely the failure mode this
  branch exists to remove — and several callers (`TableExistsCompiler` consumers, migration
  guards) currently rely on the throw to distinguish "missing" from "empty". The correct fix is in
  `Orm.reloadTableInfo()`, which should skip tables that do not exist yet; that file is also edited
  by `orm-foundation` (see the `orm.ts:111` merge hazard in the plan), so it belongs to whichever
  branch lands second, not here.

- **`orm-mssql` remains unverified against a server.** Its suite is 0 passing / 4 failing on this
  machine, every failure a `before each` hook that cannot reach an MSSQL instance. The package
  compiles and typechecks, and its contract changes (`insertReturning`, `insertIdIsFirstOfBatch`,
  `PrimaryKey[0]`) are mechanical, but nothing here is evidence that MSSQL works.

---

## 10. Changelog — branch `orm-uow` (unit-of-work persistence)

Forked from `orm-foundation` @ `6b3a05462`. Implements U1-U7 of
[the uow spec](superpowers/specs/2026-07-25-orm-uow-design.md).

**Branch context.** `orm-infra` had already landed on this branch when implementation started,
so the plan's line citations and its single-column `IModelDescriptor.PrimaryKey` assumption were
both stale. The unit-of-work pipeline is therefore **composite-key aware throughout**, built on
the existing `primary-keys.ts` helpers: `pkKeyString` for identity-map keys, `wherePk` /
`whereAnyPk` for predicates, `pkValueOf` / `setPkValue` for access.

Suite deltas against a baseline measured on this branch before any source change. Every
remaining failing title is a **subset** of the baseline — no new failures in any package:

| Package | Baseline | After | New tests |
| --- | --- | --- | --- |
| `orm` | 159 pass / 2 fail | **246 pass / 2 fail** | snapshot, model snapshot, identity map, subject, sorter, orphan policy, row transform, belongsTo middleware |
| `orm-sql` | 177 pass / 7 fail | **177 pass / 7 fail** | — |
| `orm-sqlite` | 75 pass / 8 fail | **212 pass / 1 fail** | fixtures, Populated, snapshot capture, subject building, executor, save, anti-footgun, relation atomicity, attach, static populate, m2m set ops, markDirty, single-relation populate, nested relations |
| `orm-sqlite` (integration) | 7 pass / 0 fail | **10 pass / 0 fail** | on-disk `save()` atomicity |
| `orm-mysql` | 14 pass / 9 fail | **31 pass / 4 fail** | — (integration only) |
| `orm-mysql` (integration) | 21 pass / 0 fail | **26 pass / 0 fail** | live-MySQL `save()` |
| `orm-mssql` | 0 pass / 4 fail | **0 pass / 4 fail** | — (compile-verified only) |

Seven of the baseline's failures were **fixed** as a side effect and so are absent from the
"after" column: six `orm-sqlite` relation failures (belongsTo populate, relation set/update,
union, diff) by the `SqliteModelToSqlConverter` fix below, and `Static method populate on
oneToMany` by the static-`populate()` work. The `orm-mysql` unit deltas are environmental — its
remaining four failures are `Too many connections` against the container's connection cap,
exactly as at baseline.

### What landed

- **U1 — snapshot on hydrate.** Every model hydrated from a query records a value-copy of its
  columns (`packages/orm/src/snapshot.ts`, `ModelBase.takeSnapshot`), and every populated
  relation records its member primary keys. The copy is a copy, not an alias: `Buffer`, `Date`,
  arrays and plain objects are cloned, and `snapshotEquals` compares luxon `DateTime` by instant
  and `Buffer` by content. `changedColumns()` is the diff, and a write that restores a column's
  original value produces no UPDATE.
- **U1 prerequisite — `Populated` on the eager path.** The flag was only ever set by the lazy
  `relation.populate()` methods; nothing set it when a query eagerly loaded a relation, so it
  could not distinguish anything. It is now set by `HasManyRelationMiddleware`,
  `HasManyToManyRelationMiddleware`, `OneToManyRelationHydrator` and `OneToOneRelationHydrator`.
- **U2 — identity map.** `IdentityMap`, keyed on constructor identity plus primary key, scoped
  to one `save()` graph walk and shared across saves inside one transaction via
  `ITransactionContext.IdentityMap`. Discarded with the transaction; no cross-request caching.
  Composite keys are rendered part-by-part and length-prefixed, because `String([1,2])` and
  `String(['1,2'])` are both the same string.
- **U3 — subjects.** `Subject` / `SubjectSet` and a `SubjectBuilder` with one delta builder per
  relation kind: `belongsTo` records a pending foreign key, `hasMany` diffs membership,
  `manyToMany` diffs junction rows, `Query` and `Virtual` produce nothing.
- **U4 — topological ordering.** `SubjectSorter` runs Kahn's algorithm over row-level
  foreign-key dependencies. A cycle among rows of the same model is broken by deferring the
  self-foreign-key to a follow-up UPDATE; any other cycle raises `OrmCycleException` naming the
  models involved.
- **U5 — executor.** `SubjectExecutor` runs inserts (generated keys read back and stamped onto
  dependent rows), then updates restricted to changed columns, then junction inserts and
  deletes, then the orphan policy. Key backfill mirrors `ModelBase.insert()`'s orm-infra
  behaviour — client-side keys first, `assigned` keys asserted before touching the database,
  RETURNING requested where the dialect supports it. Orphan policy is `nullify` by default,
  escalating to `delete` only when the child's foreign key is *reflected* as NOT NULL;
  `soft-delete` and `disable` are available on the decorator.
- **U6 — `save()`.** `ModelBase.save(options?)` with `{ reload?, chunk? }`, wrapping the whole
  graph in one `OrmDriver.transaction()`.
- **U7 — relation defects.** Duplicate nested-relation middleware execution (root cause fixed,
  `_.uniqBy` workaround removed), `attach()`'s undocumented switch fallthrough and name-based
  relation matching, static `populate()`'s unimplemented many-to-many branch,
  `ManyToManyRelationList.union`/`intersection`/`diff`, `SingleRelation.populate()`'s join
  column, and `SingleRelation.attach()`'s reach into the owner's private dirty-column list.

### Defects found while implementing, not in the plan

Each was blocking a task's stated deliverable, so each is fixed here rather than deferred:

- **`SqliteModelToSqlConverter` dropped foreign-key columns.** Its column loop excludes
  relation-managed FK columns, and its relation loop wrote the column only when the `belongsTo`
  had a loaded `Value` — the base `StandardModelToSqlConverter` grew a raw-column fallback for
  exactly this, the sqlite override did not. A row whose owner changed silently kept its old
  foreign key on sqlite. **This also fixed six pre-existing suite failures.**
- **`Relation` had no `Symbol.species`.** `Array` methods that derive a new collection call
  `new this.constructor[Symbol.species](len)`, which invoked the `Relation` constructor with no
  descriptor and threw dereferencing the target model — so `order.Items.splice(0, 1)` was
  unusable. Deriving plain arrays is also the right semantics: a slice of a relation is a list
  of models, not a relation. (The hand-written `map()` override predates this and worked around
  the same thing for one method.)
- **An eagerly-populated `ManyToManyRelationList` carried the wrong descriptor.**
  `ManyToManyRelation.compile()` builds a synthetic owner-to-junction descriptor (`Type: Many`,
  no `JunctionModel`) for the join query and handed that same object to the relation list, so
  `sync()` / `update()` died on a missing junction model for every eager m2m relation.
- **Static `populate()`'s `RelationType.One` branch was doubly broken.** It passed
  `descriptor.PrimaryKey` — a `string[]` since composite keys landed — straight to `where()`,
  compiling to `column 0 not exists in model ...`; and it supplied no join columns at all, so
  the LEFT JOIN referenced an undefined column.
- **`SubjectSorter` excluded promotable no-ops.** Only `Update` subjects reached the update
  phase, but a clean child re-parented to another owner classifies as `None` and only becomes an
  UPDATE once the executor writes the new owner key and re-reads the diff. `None` subjects
  carrying a pending foreign key are now included; `updatePayload` returns null for any whose
  diff is still empty, so nothing is emitted for them.
- **`save({ reload: true })` was specified backwards.** The plan moved only the *baseline*, which
  leaves the model holding the stale hydration value — so the diff reports current-to-stale and
  the UPDATE clobbers whatever another process wrote, the exact opposite of the stated intent.
  `reload` is now a three-way merge: a column the caller did not edit is reset on the model as
  well as in the baseline, so it drops out of the diff. Still last-write-wins, not conflict
  detection.

### Breaking / behaviour changes

1. **`Populated` is now true after an eager `populate()`.** Any code branching on
   `relation.Populated` to mean "was loaded lazily" changes meaning.
2. **Relation `sync()`, `update()`, `SingleRelation.set()` and `SingleRelation.remove()` are
   transactional.** Each is now one transaction (a savepoint when nested). A driver that cannot
   begin a transaction will now fail on these paths instead of writing partially.
3. **`attach()` matches relations by constructor identity, not class name.** A model with two
   relations to the same target no longer receives the row in both; a duplicated class
   definition across bundles no longer matches.
4. **`SingleRelation.populate()` joins on `Relation.PrimaryKey`.** A `@BelongsTo` with an
   explicit third argument previously loaded the wrong row through the lazy path; it now
   matches the eager path.
5. **Static `Model.populate(relation, owner)` returns a builder for many-to-many** instead of
   `undefined`, and its return type narrowed from `SelectQueryBuilder | undefined` to
   `SelectQueryBuilder`.
6. **`ManyToManyRelationList.union`/`intersection`/`diff` no longer throw.**
7. **`BelongsToRelationResultTransformMiddleware.afterQuery` returns new row objects** instead
   of mutating the rows it was handed.
8. **`IModelBase` gained `save`, `Snapshot`, `takeSnapshot`, `snapshotRelation`,
   `clearSnapshot`, `changedColumns` and `markDirty`.** A class implementing `IModelBase`
   without extending `ModelBase` must add them.
9. **`save()` rejects a graph that spans two connections** rather than committing part of it.
10. **`Relation[Symbol.species]` is `Array`.** `filter`, `slice`, `concat` and `splice` on a
    relation now return plain arrays instead of throwing.
11. **Sqlite payloads now include a `belongsTo` foreign key read from the raw column** when the
    relation has no loaded `Value`. A row whose FK column was written directly is now persisted
    rather than silently dropped.

### Known cost of the anti-footgun guarantee

Pushing onto a relation that was never populated is a **no-op** — `save()` cannot tell that
array from an unloaded one, and treating it as authoritative is exactly the TypeORM behaviour
this branch exists to avoid. Populate first:

```ts
const order = await Order.query().where({ Id: 1 }).populate('Items').first();
order.Items.push(new OrderItem({ Sku: 'A' }));
await order.save();
```

or, on an already-loaded model, `await order.Items.populate()`.

### Deferred, with reasons

- **Explicit deletion of a graph member.** `save()` has no `markForDeletion()`; every row it
  removes is removed by an orphan policy. Steps 4 and 5 of the spec's executor list therefore
  collapsed into one ordered orphan phase. Adding an explicit deletion marker is a separate,
  additive change.
- **Wrapping single-statement `ModelBase` writes in a transaction.** `insert()`, `update()`,
  `destroy()` and `insertOrUpdate()` each issue exactly one statement and are already atomic;
  a BEGIN/COMMIT pair per row would cost a round trip for nothing.
- **Genuine batched multi-row saves.** `chunk` bounds junction inserts and orphan key lists
  only. Batched inserts for auto-increment models cannot read back individual generated keys,
  and throughput work is `orm-perf`'s (overview §3.3).
- **General foreign-key cycle breaking.** Only same-model cycles are deferred. Breaking an
  arbitrary cycle by deferring any nullable foreign key is possible but was not required by the
  spec, and an error naming the models is a better default than a silently reordered write.
- **`PrimaryKeyValue`'s setter propagation for `RelationType.One`** writes the new key onto the
  `SingleRelation` wrapper rather than anywhere persisted. The executor resolves foreign keys
  itself and does not use it. Left unchanged: it has no test coverage and no bearing on `save()`.
- **`orm-sqlite`'s one remaining failure**, `Model should populate recursive relations`, is
  pre-existing and untouched by this branch.

### MySQL integration suite status

**Ran against a live server** (MySQL 8.4 via `docker compose --profile test up -d mysql`):
26 passing, 0 failing across all three `orm-mysql` integration suites, of which 5 are the new
`save()` cases. The migration declares real `FOREIGN KEY` constraints on purpose — SQLite does
not enforce them without `PRAGMA foreign_keys`, so this is what actually proves the topological
insert order rather than merely exercising it.

Two environment details, both already encoded by the sibling suites: the migration ledger table
is shared with them (`@Migration` registers globally, so a private ledger re-runs their
migrations and fails on an already-existing table), and cleanup uses `DELETE` rather than
`truncate()` because MySQL refuses to `TRUNCATE` any table named in a foreign-key constraint.

### Consumer re-verification

`orm-mssql`, `orm-api`, `orm-http`, `intl-orm`, `queue-orm-transport` and `orm-threading` all
compile. Their suites show the same pass/fail as before this branch — verified by checking out
the pre-change source, rebuilding and re-running: `orm-api` 2/4, `orm-http` 6/2, `intl-orm` 0/1,
with identical error messages, all DI-bootstrap issues unrelated to the ORM.

No source outside `packages/orm/src` reads the private dirty-column list or `.Populated`. The
one `attach()` call site (`orm-api`'s `Create.ts`) builds its models with
`new rDescriptor.TargetModel(x)`, so the constructor-identity match holds.
`packages/queue-orm-transport/test/uowCompat.test.ts` pins the relation-object surface that
package depends on.

### Environment note for a fresh worktree

Two committed-package `lib/` trees are stale relative to their `src/` and stop `orm-sqlite` from
running at all until rebuilt: `packages/http` (its built `responses.js` imports
`fast-xml-parser`, which no source references and which is not a declared dependency) and
`packages/orm-http` (its built `dto-relation.js` imports `getInheritedDescriptor`, which
`@spinajs/di` does not export). `npm run build --workspace=@spinajs/http` and the same for
`@spinajs/orm-http` clear both. No source change was needed.
