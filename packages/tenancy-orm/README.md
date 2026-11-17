# @spinajs/tenancy-orm

Tenant isolation in the SpinaJS ORM. A model declared with `@Tenant()` is confined to the current tenant of
`@spinajs/tenancy`: selects, updates and deletes built from the model get the tenant predicate, inserts get the tenant
column, and a statement with no tenant scope throws. Import `@spinajs/tenancy-orm` in the app entry before the boot, so
the Orm sees its query middleware.

See `docs/tenancy-orm/README.md`.
