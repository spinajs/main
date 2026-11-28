---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

An update with no column to write no longer sends `UPDATE ... SET WHERE ...`, which every dialect rejected with a syntax error.

- `model.update()`, `model.insertOrUpdate()` and `model.save()` (and the junction rows `save()` writes) whose changed columns are all ones `toSql()` does not write (an `undefined` property on SQLite, a relation-managed foreign key set to `undefined` while its relation holds no target) now resolve without a statement, exactly as when nothing changed: `update()` gives `{ RowsAffected: 0, LastInsertId: 0 }`, `save()` counts nothing, no query middleware or write capture runs, and the snapshot is kept, so the model stays dirty for that property. They used to reject with the driver's syntax error.
- `Model.update({})`, `Model.update()` with only `@Ignore()` properties, and `driver.update()` without values or increments reject with `InvalidArgument: update of <table> sets no column` when they compile, as an insert with no column rejects with `invalid column count`. They used to reject with the driver's syntax error. An update without a `where()` still reports the missing `where()` first.

Both are patches: every call that changes behaviour used to fail with a driver error, and every update with at least one column sends the same SQL and bindings as before.
