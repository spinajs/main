---
"@spinajs/orm": minor
---

`db.Models.Source = 'manifest'` (with `system.manifest.mode = 'require'`) takes model columns from `app.manifest.json` instead of merging `tableInfo()`. `tableInfo()` then only checks drift of declared columns: a missing one fails the boot under `db.StrictTableCheck`, a family mismatch warns, and table columns no model declares are never reported. Converters are chosen by the column's `nativeType` or the `ColumnType` name of its family, and `datetime`/`date` columns get the default datetime converter. Model JSON schema types are unchanged; `required` follows the fields' TypeScript optionality. `Orm.ColumnDrift` lists the drift found. The default stays `'database'`.
