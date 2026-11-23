---
"@spinajs/orm-history": patch
---

Conformance cases for history, and the `docs/orm-history` pages. The `orm-conformance` workflow runs them on sqlite, PGlite, Postgres and MySQL for every pull request that touches `@spinajs/orm-history`, the ORM or the audit packages. MSSQL runs only in its `mssql-nightly` job, which is started by hand (`workflow_dispatch`) or by the nightly schedule on the default branch, never by a pull request.
