---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/orm": minor
---

Models describe their SQL shape. `@Column(spec)`, `@Index(columns, options)` and `@Model(table, { columns: 'exhaustive' })` are new in `@spinajs/orm`. The manifest records a `ColumnSqlSpec` on every model column (a family inferred from the TypeScript type when there is no `@Column`), relation join keys, indexes, the `@Version` column and the exhaustive flag. `diffManifest` gains a `models` section.
