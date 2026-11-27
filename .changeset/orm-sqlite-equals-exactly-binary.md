---
"@spinajs/orm-sqlite": patch
---

`SqlExpressions.equalsExactly()` on SQLite adds `COLLATE BINARY`, so it matches byte for byte also on a column declared `COLLATE NOCASE`; a plain `=` used the column's collation and matched another case. Columns of the default collation keep their index use.
