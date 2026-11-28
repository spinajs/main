---
"@spinajs/orm": minor
---

A model whose table was missing when the `Orm` read it no longer writes a wrong row. Until `orm.reloadTableInfo()` finds the table, its static, instance and bulk `insert`, `update()`, `insertOrUpdate()` and `save()` throw `OrmException` (`model <Model>: table <table> on connection <connection> was missing when the Orm read it, so the model knows only its declared columns; create or attach the table, then call orm.reloadTableInfo()`). Before, once the table existed (a SQLite database attached after the boot, a migration's `up()`, `Runner.up()` without a reload, a table created by another process), such a write sent the declared columns only: `{ Id: 3, Ref: 'r', Name: 'given' }` was stored as `(11, 'r', 'dflt')`, with no error. A model write inside a migration's `up()` to the table that `up()` created now fails the migration; model work belongs in `data()`. The static `update()` and `destroy()` builders still run, and under `db.Models.Source = 'manifest'` nothing is refused. `IModelDescriptor.TableMissing` carries the state.

Minor, not patch: a call that resolved before now throws.
