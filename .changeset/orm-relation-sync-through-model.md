---
"@spinajs/orm": minor
---

Relation `sync()` deletes pass the model's query middleware and the write capture: `sync()` and `update()` of a one-to-many or many-to-many list build every statement on the target or junction model, so a tracked model records the orphan delete in its history, and inside a tenant the select of existing links and the orphan delete of a tenant model are confined to the tenant scope (the upserts still throw `NotSupported` there). For keys without a column converter on a single connection, the rows written and deleted are the same as before.

- Key and foreign-key values of the select of existing links, the junction delete and the one-to-many orphan delete now pass the model's column converters. A key stored in another form (a `@Uuid()` key stored as bytes) now matches its rows: before, a one-to-many `sync()` deleted the kept children and a many-to-many `sync()` replaced the kept members' links with new rows. The links found are read through the junction column's converter before they are compared with the members' keys, so `sync()` and `update()` add no duplicate link.
- The junction select and delete are qualified with the database of the junction model's own connection (`Options.Database`) instead of the target connection's. They still run on the relation's connection.
