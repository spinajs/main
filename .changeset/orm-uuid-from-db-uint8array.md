---
"@spinajs/orm": patch
---

`UuidConverter.fromDB()` reads a plain `Uint8Array` as it reads a `Buffer`: 16 bytes become the dashed uuid, other lengths their hex text. It used to return the bytes as a comma-separated list of numbers, so a driver that hands binary columns over as a `Uint8Array` read a `@Uuid()` column back wrongly, and `fromDB(toDB(x))` was not `x` for a `Uint8Array` that `toDB()` accepts.
