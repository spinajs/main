---
"@spinajs/orm": patch
---

`db.Models.Source = 'manifest'` follow-ups: `reloadTableInfo({ models })` warns only the drift of the models it read, so `migrate()` no longer repeats every recorded drift. A model whose class and table name more than one manifest model has is warned about and keeps the `tableInfo()` merge, instead of taking the first entry.
