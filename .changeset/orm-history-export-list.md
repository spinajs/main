---
"@spinajs/orm-history": minor
---

The package index names its exports: `History`, `registerHistory`, `historyOf`, `toHistoryEntry`, `HistoryConfigError`, `HistoryWriteError` and the migration `OrmHistory_2026_11_16_00_00_00`, with the types `HistoryOptions`, `TrackedModel`, `TrackedRow`, `ModelHistory`, `RowHistory`, `HistoryEntry`, `HistoryQuery`, `HistoryOp` and `AsOf`. Importing the package registers the write observer, the history reader, the `audit.data` configuration schema and the migration, as before.
