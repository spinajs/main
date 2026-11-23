---
"@spinajs/orm": patch
---

A nested belongs-to populate's conditions no longer sit under the `orWhere()` of a has-many, many-to-many or recursive populate callback. When such a callback holds an OR and populates a belongs-to relation with conditions, the relation query now reads `( a OR b ) AND ( nested ) AND fk IN (…)` instead of `( a OR b AND ( nested ) ) AND fk IN (…)`, which loaded every child matching `a` whatever the nested condition said.
