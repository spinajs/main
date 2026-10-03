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

## Databases

Residuals compile for SQLite and PostgreSQL. Both must store text as UTF-8 (SQLite's default
encoding, a PostgreSQL database created with `ENCODING 'UTF8'`): string order and the one-character
`_` of `like` follow code points only then.
