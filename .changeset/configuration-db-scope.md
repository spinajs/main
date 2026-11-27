---
"@spinajs/configuration-db-source": minor
"@spinajs/configuration-http": minor
"@spinajs/tenancy": minor
---

`configuration-db-source`: a `Scope` column (migration `configuration_db_source_2026_11_26_00_00_00`; `'shared'` for every existing row, `SHARED_SCOPE`; a `DbConfig` instance saved without `Scope` is refused, a plain-object insert takes the default) keeps rows of one scope (`tenant:acme`) out of the shared configuration and serves them through `ScopedDbConfiguration`, read again in the background after `configuration_db_source.scopedTtlMs`. A slug is unique per scope; the exposed-option sync and the watch poll read shared rows only. `configuration-http`: the routes reach the rows of the request's tenant scope (a tenant's rows inside a tenant, and a write only at a path of `tenancy.config.overridable`; the shared rows outside any tenant; `403` across all tenants); entries carry `Scope`. `tenancy`: the tenant configuration overlay also answers the rows of the tenant's scope at its overridable paths, as the schema accepted them; the tenant's own settings win.
