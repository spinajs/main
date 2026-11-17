# @spinajs/tenancy-orm

Tenant isolation in the SpinaJS ORM. A model declared with `@Tenant()` is confined to the current tenant of
`@spinajs/tenancy`: selects, updates and deletes built from the model get the tenant predicate, inserts get the tenant
column, a statement with no tenant scope throws, and a shape the middleware cannot filter is refused. Import
`@spinajs/tenancy-orm` in the app entry before the boot, so the Orm sees its query middleware.

Not covered yet: upserts; updates of the tenant column or without a condition; a to-one populate of a tenant model from
a model that is no tenant model; joins and sub-selects you write; the static `Model.populate(relation, owner)`; raw SQL,
and `driver.execute(builder)` / `executeStream(builder)`, which skip the query middlewares; schema builders, a view
over a tenant table or a table clone with data included. Do not rely on this version alone as an isolation boundary.

See `docs/tenancy-orm/README.md`.
