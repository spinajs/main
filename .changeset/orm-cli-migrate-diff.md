---
"@spinajs/orm-cli": minor
"@spinajs/orm": minor
"@spinajs/manifest": minor
"@spinajs/orm-sqlite": minor
---

`spinajs migrate-diff` writes a migration over the schema builder from the difference between the models in `app.manifest.json` and a live database. `--check` exits 1 when they differ, `--sql` prints the DDL for the connection's dialect, `--base` and `--prune` allow drops, and destructive steps stay comments unless `--allow-destructive`. `renderSql` and `runStep` in `@spinajs/orm` compile or run the planned steps. The dialect profile gains `alterColumnRebuildsTable` (set by `@spinajs/orm-sqlite`): `diffSchema` then warns `MIG006` when a column change would rebuild a table that another table references, which fails while foreign keys are enforced.
