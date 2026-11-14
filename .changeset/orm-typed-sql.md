---
"@spinajs/orm": minor
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

`sql<Row>` declares the row of a raw statement and `executeSql(fragment, { connection })` runs it. `SqlFragment` gains a phantom row parameter (`SqlFragment<R = unknown>`), so existing code compiles unchanged. The compiler records every `sql` template in the new optional `sqlQueries` manifest section.
