---
"@spinajs/orm": minor
---

`ISelectQueryBuilder.mergeRelations(builder)` is declared on the interface; the method was already public on the builder. The relation classes call `mergeBuilder`, `mergeRelations` and `JoinStatements` through the interface instead of through casts. No behaviour change.
