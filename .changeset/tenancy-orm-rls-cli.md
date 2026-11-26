---
"@spinajs/tenancy-orm": minor
---

`spinajs tenant:rls -o <dir> [--bypass-role <role>]` writes one migration per connection with the row level security of every row-mode tenant table with `rls`; it refuses a table on a connection that is not PostgreSQL or PGlite. New setting `tenancy.orm.rlsBypassRole`, the role the all-tenants scope lets through. `tenantRlsMigrationSource()` is exported. The package now depends on `@spinajs/cli` and adds its `lib/cli/commands` to `system.dirs.cli`.
