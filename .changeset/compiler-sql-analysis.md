---
"@spinajs/compiler": minor
---

`analyzeSql(query, manifest, dialect)` checks an `sql` template against the app's models with `node-sql-parser`. It returns the tables and columns the template reads, the row type it returns (with nullability through outer joins, aggregates, `CASE` and `COALESCE`) and the SQL001–SQL006 problems. It is also exported from `@spinajs/compiler/sql`.
