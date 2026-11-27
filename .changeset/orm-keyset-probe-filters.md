---
"@spinajs/orm": patch
---

`paginate()`: the probe that decides whether a refused cursor value is reported as `InvalidCursor` now sees the rows the page query may see. It runs with the model's query middlewares, with the per-query marks its query extensions copy to a clone (tenancy-orm's `acrossTenants()`, authz-orm's `accessible()` and `within()`), and with the soft-delete and archive filters. Before, it ran over every row of the table, so under a query plan in which the database's refusal depends on the rows it reads, the error a caller saw could depend on rows the page query does not read. An error a query middleware raises for the probe is now thrown instead of being replaced by the page's `DataException`.
