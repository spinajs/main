---
"@spinajs/audit-orm": patch
---

Read auditing attributes each selected column to the table its table alias names, resolved from the joins the query declares (`JoinStatement.Joined`), so a column that a `join()` query callback or a `populate()` callback selects is audited for the joined model. A column under an alias no join names counts for every audited table of the connection with a column of that name, an aggregate in a query with a join for every table of the query that has the column, and a raw or `CASE` select expression for every table of the query. Rows are named by their key only when no other column returns under its name; a `CASE` column next to the key keeps them named. `mode: 'query'` records every select of the model, `count()` and `exists()` included. A rule applies to every model of its table on its connection, junction tables included.
