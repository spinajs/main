---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-sqlite": minor
---

`query.stream({ batchSize })` returns an `AsyncIterable` of the query's rows, hydrated and populated one batch at a time. Breaking out of the loop releases the cursor. Drivers that have a cursor set `supportedFeatures().streaming` and implement `SqlDriver.executeStreamOnDb()`; sqlite steps a prepared statement. On other drivers, and inside an open transaction on every driver (a cursor would hold the transaction's connection), `stream()` pages by keyset over the query's `order()` plus the primary key, refuses a nullable order column with `InvalidArgument`, and throws `StreamNotSupported` for a query it cannot page. Relation middlewares now run on a clone of their relation query per call, so a middleware can serve more than one batch.
