---
"@spinajs/orm": major
---

`whereIn()` and `whereNotIn()` refuse a `NaN` in their list with `InvalidArgument('value cannot be NaN')`, as `where()` already does. Before, the driver bound it as `NULL`: `IN (1, NULL)` silently dropped that element, and `NOT IN (..., NULL)` matched no row at all, so an exclusion filter returned nothing and a delete or update narrowed by it touched nothing. The same check covers `where({ column: [...] })`, `Model.find()` and `Model.destroy()` with a list of keys, and relation loading. Breaking: a query whose list held a `NaN` next to valid values used to return the rows of the valid values and now throws; drop the `NaN` before the call (`ids.filter((id) => !Number.isNaN(id))`).
