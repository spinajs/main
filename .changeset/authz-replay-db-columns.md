---
"@spinajs/authz-ir": minor
"@spinajs/authz-orm": minor
---

`@spinajs/authz-orm/replay` (new subpath): importing it registers `ColumnHistoryContributor`, which rebuilds the relation columns of `@AccessResource` rows (`@Parent`, `@Owner`, `@Relation`) at a decision's instant from the current rows and the `column` changelog. Current values are read by raw select on the model's connection, so soft-deleted rows count and no access filter applies. `parent` over several `@Parent` columns is read as the union of the `parent_<column>` relations. A `@Self` column is not in the changelog, so a replay that reads it is `unreplayable`. Column coverage of a type is not trusted when a model of it has `changelog: false`, or when the fingerprint its horizon row stores is not the one this process computes for the type's relation columns (a node of another deploy wrote them).

`@spinajs/authz-ir`: `HistoryContributor` gains `project(change, source)` (the read's source; one changelog key can hold several columns), `parts(type, relation, source)` (a relation read as the union of others) and `coverageGap(type)` (read before `coveredSince`). A coverage gap of the `column` kind is named `column:<type>` in the replay's reads.
