# @spinajs/tenancy-orm

Tenant isolation in the SpinaJS ORM. A model declared with `@Tenant()` is confined to the current tenant of
`@spinajs/tenancy`: selects, updates and deletes built from the model get the tenant predicate, inserts get the tenant
column, a statement with no tenant scope throws, and a shape the middleware cannot filter is refused. Import
`@spinajs/tenancy-orm` in the app entry before the boot, so the Orm sees its query middleware.

Not covered yet: upserts, updates of the tenant column or without a condition, joins and sub-selects you write, the
static `Model.populate(relation, owner)` and raw SQL. Do not rely on this version alone as an isolation boundary.

See `docs/tenancy-orm/README.md`.
