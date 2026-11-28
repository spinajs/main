---
"@spinajs/orm": patch
---

Setting a relation-managed foreign key to `null` while its relation holds nothing is now written as NULL by `update()`, `save()` and `insertOrUpdate()`. It used to be dropped silently, or to fail with an empty `UPDATE … SET`. Inserts are unchanged.
