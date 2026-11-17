# @spinajs/tenancy-orm

Tenant isolation in the SpinaJS ORM. A model declared with `@Tenant()` (or `registerTenantModel()`) is a tenant model
of `@spinajs/tenancy`; its options default to `tenancy.orm`. This version only declares tenant models: it does not
filter any statement yet.

See `docs/tenancy-orm/README.md`.
