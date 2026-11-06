---
"@spinajs/orm": minor
---

`populate('Relation')` with a literal relation name narrows the query result: a to-one relation's `Value` is typed as the related model and a to-many relation as populated. The callback of such a `populate` is typed as a query on the related model. In strict mode (`OrmTypeRegistry.strictColumns`), `select`, `columns` and aliased aggregates narrow the row to the selected columns. New exports: `Projected`, `SourceRow`, `Rebox`, `Narrowed`, `StrictNarrowed`, `SelectNarrowed`, `StrictSelectNarrowed`, `Project`, `Reproject`, `PickColumns`, `ColumnTypeOf`, `PopulatePath`, `Head`, `Populated`, `RelationTarget`, `WithPopulated`, `PopulateName`, `PopulateTree`, `RelationLiteral` and `rel`. In strict mode `populate` rejects names that are not relations of the model, in string, array and object form; `rel(name)` passes a name computed at runtime.
