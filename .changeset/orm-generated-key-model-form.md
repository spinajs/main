---
"@spinajs/orm": patch
---

A key the database generates reaches the model in the model's form. `model.insert()`, `Model.insert(...)` and `save()` pass each key column the connection reports through the column's converter (`fromDB`) before writing it onto the model, so a `@Uuid()` key read back through `RETURNING` is the dashed text a read of the row gives instead of its 16 bytes, and an `@Int64()` key has its declared JS type. A key the caller supplied is still never overwritten.

What a caller can see: a bare `@Int64()` maps to a string, so an auto-increment key that was the number `1` right after `insert()` or `save()` on SQLite or MySQL is now `'1'`, as after a read of the row. Code that compares such a key with a number straight after the insert changes its result.
