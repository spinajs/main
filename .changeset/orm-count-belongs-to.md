---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

`count()` and `selectCount()` keep the LEFT JOIN and the conditions of a belongs-to populate, so a count agrees with the rows the same query returns. That includes a query filtered on a belongs-to relation column (`where('Author.Name', …)`, which is how `orm-http`'s `filter()` applies such a column). An aggregate column (`count`, `sum`, `min`, `max`, `avg`) of an aliased query is qualified with the alias, so it is not ambiguous next to a joined table.
