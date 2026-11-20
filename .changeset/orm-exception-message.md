---
"@spinajs/orm": patch
---

An `OrmException` turned into a string (a template literal, `String(err)`, a log line) gives its message instead of `undefined`.
