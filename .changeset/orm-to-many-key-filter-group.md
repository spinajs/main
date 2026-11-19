---
"@spinajs/orm": patch
---

A hasMany, many-to-many or recursive populate now puts the populate callback's conditions in one group before it adds the parent key filter: `populate('Items', function () { this.where(a).orWhere(b) })` runs `WHERE ( a OR b ) AND fk IN (…)` instead of `WHERE a OR b AND fk IN (…)`. Before, the first callback condition was not limited to the loaded parents, so the relation query read matching rows of every parent and dropped them only when it matched children to parents in memory; a recursive relation also started its walk from those rows. HAVING conditions stay where they are, and the relation query itself is not changed, so it can run for the next batch of parents.
