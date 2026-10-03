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
  compiled for, also those a populated relation merged into the query.
- `whereExist` and `whereNotExists` on a many-to-many relation with a scoped target test the target
  rows the residual allows. Inside a nested `where(fn)` they are refused with `Forbidden`: the orm
  builds that sub-query on the junction table alone.
- The static `Model.populate(relation, id)` joins the target table directly and is refused for a
  scoped target; populate through a query or the relation object instead.

Load authz-orm once per process: a second copy (another install, or its ESM and CJS builds together)
throws `AuthzConfigError` when it loads.

## Databases

Residuals compile for SQLite and PostgreSQL. Both must store text as UTF-8 (SQLite's default
encoding, a PostgreSQL database created with `ENCODING 'UTF8'`): string order and the one-character
`_` of `like` follow code points only then.
