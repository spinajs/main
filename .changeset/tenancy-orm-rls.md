---
"@spinajs/tenancy-orm": minor
---

Row level security for row-mode tenant tables on PostgreSQL and PGlite. `generateTenantRls()` writes, for each table of a model with `rls` (`@Tenant({ rls: true })` or `tenancy.orm.rls: true`), ENABLE and FORCE ROW LEVEL SECURITY, the RESTRICTIVE policy `spina_tenant_isolation` (the tenant column must equal `spina.tenant`; across tenants only for the bypass role) and the permissive `spina_tenant_open`, which grants nothing once another permissive policy is on the table. `TenantSessionSettings` sends `spina.tenant` and `spina.tenant_all` with every statement in a tenant scope on such a connection, so those statements run in a transaction of their own and do not stream from a server cursor. On such a connection `.acrossTenants()` throws `InvalidOperation` inside a tenant scope and with no scope (use `runAcrossTenants()`), and on any connection with `rls` a transaction keeps the scope of its first statement on any table, not only on a tenant table.
