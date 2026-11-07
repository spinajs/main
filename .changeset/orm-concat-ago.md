---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-sqlite": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-mssql": minor
---

`whereColumn()` takes `concat(...parts)` as its right side: the parts joined by the driver's `SqlExpressions.concat`, a string or number bound as a parameter, `outer()` and a `Wrap` qualified as `whereColumn()` qualifies columns. `OrmDriver.ago(amount, unit)` is the database's `now()` less `amount` seconds, minutes, hours or days, computed when the statement runs; each SQL driver implements the new `SqlExpressions.ago()` on the clock of its `NowExpression`.
