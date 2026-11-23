---
"@spinajs/orm-sql": patch
---

`where()`, `whereIn()`, `whereNotIn()` and `BETWEEN` convert a bound value the same way: the column's declared converter with its options, else one chosen by the value's class, both given the model's column. A `Date` bound against an undecorated numeric column no longer binds seconds in `where()` and datetime text in the others.
