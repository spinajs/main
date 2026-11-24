---
"@spinajs/orm": patch
---

A key the database generates reaches the model in the model's form. `model.insert()`, `Model.insert(...)` and `save()` pass each key column the connection reports through the column's converter (`fromDB`) before writing it onto the model, so a `@Uuid()` key read back through `RETURNING` is the dashed text a read of the row gives instead of its 16 bytes, and an `@Int64()` key has its declared JS type. A key the caller supplied is still never overwritten.
