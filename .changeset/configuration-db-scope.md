---
"@spinajs/configuration-db-source": minor
"@spinajs/configuration-http": minor
"@spinajs/tenancy": minor
---

`configuration-db-source`: a `Scope` column (migration `configuration_db_source_2026_11_26_00_00_00`; `'shared'` for every existing row, `SHARED_SCOPE`; a `DbConfig` instance saved without `Scope` is refused, a plain-object insert takes the default) keeps rows of one scope (`tenant:acme`) out of the shared configuration and serves them through `ScopedDbConfiguration`, read again in the background after `configuration_db_source.scopedTtlMs`. A slug is unique per scope; the exposed-option sync and the watch poll read shared rows only. `configuration-http`: the routes list, read and update shared rows only (`Scope = 'shared'`), and a request inside a tenant scope or across all tenants is now refused with `403` (`ConfigScopeRefused`) on every route: a tenant's overrides are written through `TenantSettingsService`. Entries carry `Scope`. `tenancy`: the tenant configuration overlay also answers the rows of the tenant's scope at its overridable paths, as the schema accepted them; the tenant's own settings win.
