---
"@spinajs/tenancy-orm": minor
---

New package `@spinajs/tenancy-orm`: the tenant model registry. `@Tenant(options)` and `registerTenantModel(model, options)` declare a tenant model; the model declares the tenant column itself (default `tenant_id`, renamed with `column`). `tenantModelOf`, `tenantModelOfTable` and `tenantModels` look tenant models up; a subclass resolves to its nearest registered ancestor, the tables of the ORM's models under a tenant model are tenant tables, in any letter case, and `tenantModels()` lists one entry per such model with its own table. `tenancy.orm.isolation`, `tenancy.orm.column` and `tenancy.orm.rls` are the defaults of every tenant model, checked by the configuration schema of `tenancy.orm`. `isolation: 'schema'` is refused with `NotSupported` until schema placements land. This version filters no statement yet.
