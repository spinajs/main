---
"@spinajs/util": minor
---

`asPlainObject`, `asString` and `toFiniteNumber` read fields of untyped data such as parsed JSON: each returns the value when it has the expected shape, otherwise `undefined`. `toFiniteNumber` also accepts a numeric string.
