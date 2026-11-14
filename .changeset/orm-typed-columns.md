---
"@spinajs/orm": minor
---

Column arguments of the query builder are typed from the queried model. In the default loose mode they only add editor completion; a package opts into strict mode with `declare module '@spinajs/orm' { interface OrmTypeRegistry { strictColumns: true } }` in a `src/*.d.ts`, after which unknown columns and mistyped `where` values are compile errors. `col(name)` passes a column the model does not declare. New exports: `OrmTypeRegistry`, `OrmStrict`, `ColumnName`, `ColumnRef`, `ColumnArg`, `ColumnValue`, `WhereColumn`, `col`, the other helper types of `typing.ts` (`RelationName`, `QualifiedColumn`, `ColumnLiteral`, `WhereCatchAllColumn`, `WhereValue`, `WhereOperator`) and `ITypedColumnsBuilder`, which `ISelectQueryBuilder` now extends in place of `IColumnsBuilder`, `IOrderByBuilder` and `IGroupByBuilder` (still its ancestors).
