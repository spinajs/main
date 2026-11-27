---
"@spinajs/tenancy-orm": patch
---

A sub-query on a tenant model is now confined to the tenant scope the statement runs in. Before, only the statement that executes was confined, so inside tenant `t1` `Carrier.query().whereIn('name', Invoice.query().select('code'))` read the invoice codes of every tenant, `whereExist(Invoice.query().where(...))` told whether a row of another tenant exists, and an update or delete with such a `whereIn` changed rows selected through another tenant's data. Each select compiled into a select, update or delete now gets the same tenant condition as a statement, depth first: `whereIn` / `whereNotIn` / `whereExist` / `whereNotExists` with a query, the relation forms of `whereExist` (belongsTo, hasMany, the junction select of a many-to-many), nested groups, join callbacks, `selectCondition()` columns and to-one populate callbacks.

An application sees:

- With no tenant scope, a statement that holds a sub-query on a tenant model throws `TenantRequired`, where before it read every tenant's rows. Run it inside `runInTenant()`, or leave the scope with `runAcrossTenants(reason, fn)`.
- `.acrossTenants(reason)` widens the builder it is called on only: on a statement it does not widen the statement's sub-queries, so `this.acrossTenants(reason).whereIn(column, query)` in a `sync()` callback keeps the sub-query in the current tenant. Mark the sub-query too to widen it. On a connection with tenant settings a sub-query in another scope than its statement throws `TenantSwitchDenied` inside a transaction.
- A sub-query that reads a tenant table without its model (`driver.select().from('invoice')`) throws `NotSupported` inside a tenant.
- A builder is confined once: one that already ends in the tenant condition of the current tenant (a sub-query that also ran on its own, a clone of a confined query) gets no second one. Other statements without a sub-query on a tenant model compile to the same SQL as before.

Not seen, as before: SQL text, a sub-query attached inside a `Lazy` or by a query middleware ordered after 80, the table a many-to-many `whereExist` joins to its junction select, schema statements, and `driver.execute(builder)` / `executeStream(builder)`.
