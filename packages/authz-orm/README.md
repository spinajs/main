# `@spinajs/authz-orm`

ORM adapter for SpinaJS authorization.

## Setup

- `import '@spinajs/authz-orm'` registers `OrmResourceAdapter` (a `ResourceAdapter` for every
  `@AccessResource` type), `AuthzQueryMiddleware` (order 100) and the contributor that feeds
  `joinTypes` to the boot checks.
- Mark models with `@AccessResource(type, opts)`, `@Owner()`, `@ScopeColumn(column, scopeType)`;
  scope relations with `@OrmScope(model, relation)` on an `OrmScopePolicy`; models a package does
  not own with `registerAccessResource`. Register them before the authz domain boots (at import,
  or in a `Bootstrapper`; a model module imported lazily after boot is late): a type registered
  later makes every check, list, summary and covers on it throw `AuthzConfigError` until the
  domain boots again.
- `ownsBy(type, relation, fn)` is an in-memory relation with no SQL form, for `@AccessResource` types
  only: `fn` gets the row of the checked ref, loaded through the adapter when the subject is not
  that row.
- `authz.orm.domain` (default `root`) names the domain whose `AuthzService` scopes queries.
- `authz.orm.allowJit` (default `false`): on Postgres, authz-orm refuses a connection with
  `jit = on` (Postgres's default; rule lists then take seconds) at domain boot or at its first
  scoped query. Turn jit off for the app's role or database (`ALTER ROLE … SET jit = off`), or
  start the process with `PGOPTIONS='-c jit=off'`.
- Queries run as the ALS principal. `authz().runAs(SYSTEM, reason, fn)` and a route's
  `@Unscoped(reason)` run unscoped (audited); without a principal (UNATTENDED) a query on a scoped
  model throws `AccessDenied`.

## `@OrmScope` policies

A policy's `scope(query, principal, op)` is SQL that runs in two places: a check (the default
`holds`, an `EXISTS` of the row by primary key, always with op `read`) and a list (the residual
compiled into the query, with the query's op). Both run it as `SYSTEM`, so:

- read the principal from the `principal` argument only; `currentPrincipal()` is `SYSTEM` there;
- sub-queries the policy builds on other models are not scoped by authz;
- keep it synchronous and the same for every op, or implement `holds` to match what the op-specific
  scope does;
- a policy cannot be an `AsyncService`: residuals compile synchronously.
- `scope` and `OrmNativeCompiler.compile` must add their conditions before they return; one that
  returns a promise is refused with `AuthzConfigError`.
- a policy that scopes by a column an update can write must implement `authorizeUpdate`: the update
  check reads the policy's relation from the stored row, not from the written values.

## What the query middleware does not see

The middleware scopes queries built with the orm. It does not see, and cannot scope:

- SQL the app writes itself: `RawQuery` in `where`, `select` or `join`, `driver.executeOnDb`, and
  views over a scoped table (`CREATE VIEW v AS SELECT * FROM task` reads every row). A raw where
  fragment with unbalanced parentheses can also close the group the middleware puts the caller's
  where in.
- DDL: `DROP TABLE`, `ALTER TABLE` and other schema builders on a scoped table are not gated.
- Values a later middleware or the caller changes after authz's `beforeQueryExecution` ran (order
  100): insert and update payloads are checked as they are at that point.

Queries that reach a scoped table without its model's scope (no model, a join, truncate, a deep
clone) fail closed. Tables are matched by name, case-insensitively and across connections, so a
table of the same name on another connection is refused too. An update that writes a column the
residual reads loads the rows it reaches (as `SYSTEM`) to check them.

An insert or update of a scoped model compiles once, after its execution checks ran. Calling `toDB()`
on one before `await` (to log or explain it), or after it ran, or passing it to `driver.execute()` is
refused with `Forbidden`, whether its values changed or not. A truncate or deep clone of a scoped
table likewise compiles once, after the gate passed it in `beforeQueryExecution`.

## Relations, sub-queries and clones

- A populated relation (belongsTo, hasMany, many-to-many) and the `populate()` of a relation object
  read only the target rows the target's residual allows. For a many-to-many the residual filters the
  junction query; a junction model that is an `@AccessResource` adds its own residual on the junction
  rows.
- A relation or sub-query whose type the principal may not read makes the whole query fail with
  `AccessDenied`. A residual that needs IO (a model with `sync: 'never'`) resolves for every relation
  and sub-query before the query that compiles them runs; one compiled but never run stays FALSE.
- `clone()` (and the counts and pages built from a clone) keeps every residual on the table it was
  compiled for, also those a populated relation merged into the query, and the caller's `orWhere`
  connectors (the orm's clone turns them into AND).
- A builder runs only for the principal it was built for: the same object, or one with equal data
  (id, attributes, authn facts, ceiling, delegation and the rest). Run by any other principal (the
  same user with other attributes or without MFA included) it fails with `Forbidden`; SYSTEM may run
  it. Data is compared only in plain objects and arrays whose own properties are all enumerable,
  string-keyed values; a principal with a hidden, symbol-keyed or getter field anywhere is the same
  only as the very same object.
- `whereExist` and `whereNotExists` on a many-to-many relation with a scoped target test the target
  rows the residual allows. Inside a nested `where(fn)` they are refused with `Forbidden`: the orm
  builds that sub-query on the junction table alone.
- The static `Model.populate(relation, id)` of a hasMany builds a target query, which is scoped;
  for a belongsTo or many-to-many it joins the target table directly and is refused for a scoped
  target: populate through a query or the relation object instead.

Load authz-orm once per process: a second copy (another install, or its ESM and CJS builds together)
throws `AuthzConfigError` when it loads.

## Databases

Residuals compile for SQLite and PostgreSQL. Both must store text as UTF-8 (SQLite's default
encoding, a PostgreSQL database created with `ENCODING 'UTF8'`): string order and the one-character
`_` of `like` follow code points only then.

The B06 property tests (`test/b06.property.test.ts`) run `AUTHZ_ORM_B06_RUNS` times per dialect
and model kind, 20 by default; the lane acceptance runs them with `AUTHZ_ORM_B06_RUNS=100` or more.

## Field filtering

`filterFields(decision, data, mode)` keeps the fields of `data` that `decision.fields[mode]` allows
(field globs, `filterObject` semantics). Values come back JSON-shaped: `toJSON` runs first, so a
model gives the record its `toJSON()` returns (a `@Hidden` column is never there). An array is a
list of records: each element is filtered on its own, and paths do not name array indexes.
`removed` lists the dropped paths sorted, a subtree dropped whole as one path, an array's path for
the scalar elements dropped from it. A denied decision keeps nothing: `{}` for a record, `[]` for an
array.

## Database audit

`DbDecisionAudit` (from `@spinajs/authz-orm/audit`) writes one `authz_audit` row per audit record:
`id` (uuid), `at`, `kind`, `principal` (`type:id`), `permission`, `resource` (`resourceKey`),
`reason`, `trace` (JSON; for an `admin` record the command). Longer values are cut to the column
widths. A failed write is logged (`authz-audit`) and the record dropped; it never fails a check.

1. Import `@spinajs/authz-orm/audit` before the ORM boots. It registers the `AuthzAuditEntry` model
   and the migration `AuthzAudit_2026_10_01_00_00_00`, both on the connection named `authz-audit`.
2. Map that name: `db.Aliases: { 'authz-audit': 'default' }`, or configure a connection of that
   name. Without one the migration is skipped with a warning and every record fails.
3. Register and select it:
   `DI.register(DbDecisionAudit).as(DecisionAudit)` (or in a domain's container), with
   `authz.audit.service: 'DbDecisionAudit'` (or `authz.domains.<name>.audit.service`).

The import does not register it as the `DecisionAudit`: without `authz.audit.service` the host
takes the last one registered, so loading the module would silently replace the log audit.

`at` holds UTC time without an offset, whatever the server's time zone, so rows from hosts in
other zones compare and the hour repeated when daylight saving ends sorts right. Through the model
it reads back as a luxon `DateTime` in the local zone; `at.setZone('utc', { keepLocalTime: true })`
gives the instant.

## Native compilers

An `OrmNativeCompiler` writes its condition into the builder it is handed (one that adds none is
refused with `AuthzConfigError`, never read as TRUE); the compiler wraps it in
parentheses and under `NOT` as the residual needs. To test another table (a correlated `EXISTS`,
as authz-rbac's `native:rbac.assignment` does), import the helpers from
`@spinajs/authz-orm/native`:

- `correlatedQuery(builder, tableOrModel)`: `SELECT 1 FROM <table>` under its own alias, for
  `whereExist(...)` or `whereNotExists(...)` on the native builder, a where group in it, or another
  sub-query (subs nest: `NOT EXISTS` of a restriction inside a membership `EXISTS`);
- `correlate(holder, column, outerColumn)`: `<sub>.<column> = <filtered row>.<outerColumn>` in a
  sub-query or in a where group of one. At the sub-query's top level its other conditions are ANDed
  after the correlations, so an `orWhere` there cannot reach past them. In a group the correlation
  is ANDed with that group's conditions, so `onPath` is one `EXISTS`: a group per path column,
  joined with `orWhere(fn)`. A sub-query with no correlation at its top level refuses an `orWhere`
  there (it would reach around the groups). At any depth, an `orWhere` that joins a group holding a
  correlation with a condition holding none is refused when the query compiles: correlate every
  operand of such an OR, or keep the OR inside the correlated group. An `EXISTS` or `NOT EXISTS`
  over a correlated sub-query counts as holding a correlation; one written in an `sql` fragment
  does not;
- `whereSql(holder, fragment)` adds an `` sql`…` `` fragment, in which `outerColumn(builder, col)`
  is the filtered row's column, `subColumn(sub, col)` a sub-query's own column and `identifier(name)`
  a quoted name. It writes SQL the helpers above cannot build, such as `below` (a `CASE` over the
  row's path columns) or `attr()` (`COALESCE((SELECT …), :default)` with the row's column in the
  scalar sub-select). Other values in the template are bound: a string, number, boolean, `null` or
  `Buffer` as one parameter; a `Date` in the form the orm writes datetimes (the connection's
  datetime converter: local time text, so it compares with columns the orm wrote; an invalid `Date`,
  or one the converter cannot write, is refused, as it would bind as NULL); a `bigint` as a number
  when exact, else as its decimal text cast to an integer (`CAST(? AS INTEGER)` on SQLite, `bigint`
  on PG), so it compares as an integer (on PG a text operand is an error and a double precision
  operand compares as double; one outside the 64-bit integers is refused); an array as one parameter
  per element (`IN (${roles})`; an empty array is refused, so test the empty list in the
  compiler); anything else is refused. The fragment is parenthesised, and `sql` refuses literal text
  that could leave those parentheses or shift the bindings: unbalanced brackets, `;`, `--`, `/*`,
  `#`, `[`, `]`, `$`, `?`, SQLite named parameters (`:x`, `@x`, and `:::x`, `@::x`, since a SQLite
  parameter name runs on over `::`; PG's `::type`, `@>` and `<@` are fine), an
  unclosed quote, and a backslash, a `?` or a value inside a quoted literal, also where a nested
  fragment meets the text around it. Its NULL handling (Kleene) is the compiler's job;
- `whereSqlWithAliases(holder, fragment, aliases)`: as `whereSql`, for a fragment whose nested
  SELECTs name their tables by `aliases`; when the query compiles, a filtered row that goes by one of
  them (in any letter case) is refused, as the nested SELECT would shadow it;
- `isNativeBuilder(builder)`: whether `builder` is the native builder, a where group in it or a
  correlatedQuery sub-query of it (code that also builds SQL outside authz-orm picks `whereSql` by
  it);
- `scopeColumnsOf(model)`: the model's `@ScopeColumn`s, nearest ancestor first;
- `scopePathOf(model)`: how the adapter reads a registered model's rows (null for any other model):
  its type and table, its primary key and its `@ScopeColumn`s, each with the `IdMode` the adapter
  reads ids by (`string`, `number`, `text`, or `none` for a column the orm does not know and for
  every column of a model on a driver other than SQLite or Postgres), and its `@AccessResource`
  attributes, and the keys of the models of its type registered before it (`before`: `findRow`
  tries them first; null for one on another connection or without a readable table or key). For an
  unregistered subclass it gives the registered class's key mode and scope columns, which `findRow`
  and `ancestors` read, and key mode `none` when the subclass reads another table. With it a compiler
  matches `ancestors`, `findRow` and `scopeAttributes`;
- `accessResourceModels(type?)`: the registered model classes (of `type`), in registration order,
  the order `findRow` tries them in;
- `accessResourceTypeOf(model)`: the type a class is registered as (undefined for any other class).

Every name is resolved when the query compiles, so an alias given later (`populate()`,
`setAlias()`), clones, counts of clones and subs nested in subs always name the filtered row; a
correlation that cannot find that row throws `AuthzConfigError` rather than render FALSE (under
`NOT EXISTS` FALSE would allow the row).

authz does not scope these sub-queries: read the principal from the `principal` argument, and read
only tables that are not `@AccessResource` models (L4b reads `authz_*` tables, and a scope type's
model table only to test that the node row exists, as the adapter does as SYSTEM). A sub-query over a
scoped model's table, or its name in an `sql` fragment, sees every row of it. Lazy statements (the
orm's deferred `EXISTS`) are refused, because the orm moves them after the other conditions and
would change the grouping.

A compiler for an op whose `NativeFilter` declares `principalInArgs` must not read its `principal`
argument: an intersect agent's residual keeps its delegate's terms (RFC E2-2), so `principal` is the
agent while the args name the delegate.

On PostgreSQL 12 and later, a large native term (authz-rbac's rule terms: many correlated sub-plans,
a high estimated cost, a few rows) passes the default `jit_above_cost`, and the server JIT-compiles
every list query: measured 25-30 s per query, 13 s of it JIT, for 3.4 ms of work. Hosts turn JIT off
for the connection authz lists through (`ALTER ROLE <role> SET jit = off`, or the same per
database). Raising `jit_above_cost` is no fix: the plans' cost grows with the rows listed.

authz-rbac's terms over stored rules (args v2 `dbRules`, `native:rbac.threshold` `{ db: true }`) are
one `WITH … AS MATERIALIZED` each, which needs PostgreSQL 12 or SQLite 3.35 or later (an older server
fails every such list with a syntax error). SQLite works the row-correlated WITH tables out again at
each reference: about 0.45 s per filtered row with four stored rules, so on SQLite such lists suit
small tables only until authz-rbac reads the rule tables by joins. On Postgres they log "Slow
orm.query" warnings.

### ABAC scope leaves

With `authz.<model>.scopeResiduals` on (`AbacModelOptions.scopeResiduals`), an ABAC model answers a
list's comparisons of `scope.<type>.*` with residual leaves of the op `native:condition.scope`.
authz-rbac compiles them (`ConditionScopeOrmCompiler`, registered when its orm module loads), so an
ABAC list through authz-orm with the switch on needs authz-rbac loaded; without it boot rule 4
refuses the route (the op is not in this adapter's `compiles`). The leaf reads scope attributes as
authz-rbac's rule SQL does: layers and schema defaults from the host's `RbacScopeAttributeSource`
(else no defaults and the layers authz-orm serves), with the same limits (a value SQL cannot
compare, or a layer it cannot read, refuses the row). On Postgres it too needs `jit = off`.

`@spinajs/authz-orm/native` is a contract between lanes L4 and L4b, outside the API snapshot: change
it only together with L4b.
