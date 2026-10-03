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

An insert or update of a scoped model compiles only after its execution checks ran: calling `toDB()`
on one before `await` (to log or explain it), or passing it to `driver.execute()`, is refused with
`Forbidden`, and so is a builder whose values changed after the checks. A truncate or deep clone of a
scoped table compiles only after the gate passed it in `beforeQueryExecution`.

## Databases

Residuals compile for SQLite and PostgreSQL. Both must store text as UTF-8 (SQLite's default
encoding, a PostgreSQL database created with `ENCODING 'UTF8'`): string order and the one-character
`_` of `like` follow code points only then.
