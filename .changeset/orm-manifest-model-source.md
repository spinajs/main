---
"@spinajs/orm": minor
---

`db.Models.Source = 'manifest'` (with `system.manifest.mode = 'require'`) takes model columns from `app.manifest.json` instead of merging `tableInfo()`. `tableInfo()` then only checks drift of declared columns: a missing one fails the boot under `db.StrictTableCheck`, a family mismatch warns, and table columns no model declares are never reported. Converters are chosen by the column's `nativeType` or the `ColumnType` name of its family, and `datetime`/`date` columns get the default datetime converter. Model JSON schema types are unchanged; `required`, the write-time NOT NULL check and the defaults follow the fields' TypeScript optionality and `@Column({ default })`, not the table, and the boot warns about a required column the table allows to be NULL or fills with a default. `Orm.ColumnDrift` lists the drift found. The default stays `'database'`.
