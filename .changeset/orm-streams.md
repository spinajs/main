---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-sqlite": minor
---

`query.stream({ batchSize })` yields the query's rows hydrated and populated one batch at a time: from a driver cursor where the connection can hold one (sqlite: a read handle of a WAL database), otherwise by keyset pages. Relation middlewares run on a copy of their relation query per call, so one can serve several batches.
