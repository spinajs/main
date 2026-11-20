---
"@spinajs/orm": minor
"@spinajs/orm-sql": minor
"@spinajs/orm-mysql": minor
"@spinajs/orm-postgres": minor
"@spinajs/orm-sqlite": minor
---

`@DateTime({ unit: 'milliseconds' })` stores epoch milliseconds in a numeric column, and `where()` / `whereIn()` bind a `DateTime` or a number for that column in the same unit; numeric text (pg `int8`, MSSQL `bigint`, mysql2 `DECIMAL`) is read in the declared unit. `@DateTime({ nullable: true })` accepts a property typed `DateTime | null`. New export `IDateTimeConverterOptions`.
