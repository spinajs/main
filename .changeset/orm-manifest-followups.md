---
"@spinajs/orm": patch
---

`db.Models.Source = 'manifest'` follow-ups: `reloadTableInfo({ models })` warns only the drift of the models it read, so `migrate()` no longer repeats every recorded drift.
