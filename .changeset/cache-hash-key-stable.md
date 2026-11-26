---
"@spinajs/cache": minor
---

`hashKey(parts)` gives equal parts one key: a string by its value however it was built, object keys, `Map` entries and `Set` items in any order, `-0` as `0`, a property that holds `undefined` as a missing one, a `Date` by its time and a `Buffer` or typed array by its kind and bytes. Parts of different types (`1`, `1n`, `'1'`) never share a key. A key part may be a string, number, bigint, boolean, `null`, `undefined`, plain object, array, `Date`, `Map`, `Set` or bytes; a function, a symbol, a class instance and a cyclic object are refused with `InvalidArgument`, which names the part and says what to pass instead (a luxon `DateTime` as `toISO()` or `toMillis()`, a model as its primary key).
