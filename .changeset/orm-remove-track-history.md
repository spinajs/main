---
"@spinajs/orm": major
"@spinajs/orm-sql": major
"@spinajs/orm-mysql": major
"@spinajs/orm-sqlite": patch
"@spinajs/orm-mssql": patch
"@spinajs/compiler": patch
---

Removed the trigger-based table history: `TableQueryBuilder.trackHistory()` and `TrackHistory`, `TableHistoryQueryCompiler`, `SqlTableHistoryQueryCompiler` (and its MySQL registration), the `@Historical(targetModel)` relation decorator, `HistoricalModel` and `IHistoricalModel`. Only MySQL could compile it, and its triggers broke inserts after a later `ADD COLUMN`. `@spinajs/orm-history` replaces it.
