---
"@spinajs/orm": minor
"@spinajs/orm-sql": patch
"@spinajs/orm-mssql": minor
"@spinajs/orm-http": patch
"@spinajs/users-http": patch
---

`LikeLiteral.contains(text)`, `.startsWith(text)` and `.endsWith(text)` are `like` operands matched literally: the dialect's wildcards are escaped (on MSSQL `[` too) and the statement declares `ESCAPE '~'`; a plain string stays a raw pattern. orm-http's `like`, `b-like` and `e-like` filter operators and the admin user list's `user:niceName` filters now match the client's value literally, so `%` or `_` in a filter value no longer matches every row or any character, and a client that sent them as deliberate wildcards gets literal matching instead. An application's own filter query that builds a LIKE pattern from the client's value (`@Filterable(..., query)`, `IColumnFilter.query`) is not fixed by upgrading: pass `LikeLiteral.contains(value)` there. `MsSqlWhereStatement` and `MsSqlStartsWithStatement` are exported.
