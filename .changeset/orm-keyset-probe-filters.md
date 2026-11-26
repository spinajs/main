---
"@spinajs/orm": patch
---

`paginate()`: the probe that decides whether a refused cursor value is reported as `InvalidCursor` now runs with the model's query middlewares (such as the tenant and authz row filters) and its soft-delete and archive filters. Before, it ran over every row of the table, so under a query plan in which the database's refusal depends on the rows it reads, the error a caller saw could depend on rows of other tenants and on soft-deleted or archived rows.
