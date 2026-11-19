---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
---

Every SQL statement a builder executes now produces an OpenTelemetry `db.query` CLIENT span (through `@spinajs/tracing`), parented to the active span, with `db.system.name`, `db.operation.name`, `db.collection.name`, the sanitized `db.query.text`, `spina.db.fingerprint` and `spina.db.connection`. Bindings never reach the span, and a failed statement records only its error type. A streamed select (`stream()`) gets one span that ends when the stream ends. `@spinajs/orm` exports `sanitizeSql`, `fingerprint` and the executed-statement side channel (`recordStatement`, `executedStatements`, `adoptStatements`, `setStatementRecording`, `statementRecording`), through which `SqlDriver.execute` hands each statement to query middlewares while one asked for them. `OrmDriver.ansiQuotedIdentifiers()` tells whether `"name"` is an identifier on the connection.
