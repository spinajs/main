# `@spinajs/authz-orm`

ORM adapter for SpinaJS authorization.

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
  it.
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

## Native compilers

An `OrmNativeCompiler` writes its condition into the builder it is handed; the compiler wraps it in
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
  there (it would reach around the groups);
- `whereSql(holder, fragment)` adds an `` sql`…` `` fragment, in which `outerColumn(builder, col)`
  is the filtered row's column, `subColumn(sub, col)` a sub-query's own column and `identifier(name)`
  a quoted name. It writes SQL the helpers above cannot build, such as `below` (a `CASE` over the
  row's path columns) or `attr()` (`COALESCE((SELECT …), :default)` with the row's column in the
  scalar sub-select). Other values in the template are bound; the fragment is parenthesised, and its
  NULL handling (Kleene) is the compiler's job;
- `scopeColumnsOf(model)`: the model's `@ScopeColumn`s, nearest ancestor first.

Every name is resolved when the query compiles, so an alias given later (`populate()`,
`setAlias()`), clones, counts of clones and subs nested in subs always name the filtered row; a
correlation that cannot find that row throws `AuthzConfigError` rather than render FALSE (under
`NOT EXISTS` FALSE would allow the row).

authz does not scope these sub-queries: read the principal from the `principal` argument, and read
only tables that are not `@AccessResource` models (L4b reads `authz_*` tables). A sub-query over a
scoped model's table, or its name in an `sql` fragment, sees every row of it. Lazy statements (the
orm's deferred `EXISTS`) are refused, because the orm moves them after the other conditions and
would change the grouping.

`@spinajs/authz-orm/native` is a contract between lanes L4 and L4b, outside the API snapshot: change
it only together with L4b.
