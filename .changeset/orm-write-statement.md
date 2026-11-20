---
"@spinajs/orm": minor
---

`WriteObserver.interest()` and `prepare()` take a `WriteStatement` (`kind`, `query`, `model`) instead of the bare builder, and `CapturedWrite` is that statement plus the driver and the rows. `kind` narrows `query` to `InsertQueryBuilder`, `UpdateQueryBuilder` or `DeleteQueryBuilder`, so an observer no longer classifies the write with `instanceof`. `writeStatementOf(query)` builds the statement for a builder. An observer written against the earlier signature reads `statement.query` or `statement.model` where it read the builder.
