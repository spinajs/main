---
"@spinajs/orm": minor
"@spinajs/orm-sqlite": patch
"@spinajs/compiler": minor
---

`@Ignore()` now means "not persisted". No insert, update, upsert, bulk insert or unit-of-work save writes an `@Ignore()` property, on any driver, and `dehydrate()` omits it. Relation queries no longer select it, and a change to it alone does not make the model dirty. A query that returns a column of that name still hydrates it. Behaviour changes: an `@Ignore()` on a property that does have a table column stops being written, and table info no longer clears the flag. `toJSON()` and `dehydrate()` now omit `@Ignore()` properties, so an app that returned such an in-memory value in an API response loses it. A new instance no longer gets a table default for an `@Ignore()` property, and `refresh()` keeps one the row did not return. `@Ignore()` and `@Primary()` on the same property throw `InvalidArgument`.

The compiler treats `@Ignore` members as computed: they are not listed as model columns in the manifest, so `migrate-diff` never proposes a column for them, and they are left out of derived model schemas. Those schemas are closed, so a request body that still sends an `@Ignore` field is now rejected.
