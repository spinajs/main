---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
"@spinajs/orm-http": patch
---

`where(column, 'between' | 'not between', [from, to])` binds the pair as `BETWEEN ? AND ?`, so the orm-http `between` and `notbetween` filters work instead of answering 500. `where()` refuses anything but an array of exactly two values, none of them null, undefined or NaN (a `RawQuery` is still accepted), and each bound is converted like a single `where()` value.
