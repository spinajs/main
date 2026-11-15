# @spinajs/testing-orm

Databases and data for ORM tests.

- [Test databases](./01-test-databases.md): `createTestDatabase()`, a fresh PostgreSQL schema per test on one
  in-process PGlite, or a copy of a migrated template.
- [Model factories](./02-factories.md): `defineFactory()`, `factory()`.

It builds on `@spinajs/testing` (`createTestApp`) and `@spinajs/orm-pglite`.
