---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

`SelectQueryBuilder.clone()` rebinds only its own statements to the copy. A join or where merged in from a nested relation query (a belongsTo nested in a populated relation) keeps the alias of the query it came from, so a clone of an executed populated query and a clone of a many-to-many junction query compile and return the same rows as the original.
