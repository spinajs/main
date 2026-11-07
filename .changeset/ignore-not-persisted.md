---
"@spinajs/orm": minor
"@spinajs/orm-sqlite": patch
"@spinajs/compiler": patch
---

`@Ignore()` now means "not persisted". No insert, update, upsert, bulk insert or unit-of-work save writes an `@Ignore()` property, on any driver, and `dehydrate()` omits it. Relation queries no longer select it, and a change to it alone does not make the model dirty. A query that returns a column of that name still hydrates it. Behaviour change: an `@Ignore()` on a property that does have a table column stops being written, and table info no longer clears the flag. `@Ignore()` and `@Primary()` on the same property throw `InvalidArgument`.

The compiler treats `@Ignore` members as computed: they are not listed as model columns in the manifest, so `migrate-diff` never proposes a column for them, and they are left out of derived model schemas.
