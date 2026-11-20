---
"@spinajs/orm": minor
---

`SelectQueryBuilder.clone()` takes an optional owner relation, `clone(owner?)`. The ORM passes it when a query with a populated relation is cloned, so that the copy of the relation owns the clone of its query; it replaces an internal second clone function. **A subclass that overrides `clone()` must take the argument and pass it on (`super.clone(owner)`).** An override without it still compiles and gives that relation a query owned by the relation it was copied from. `IWhereBuilder` no longer declares `clone(parent)`, so `IUpdateQueryBuilder` and `IDeleteQueryBuilder` no longer expose it either. The method stays on the `WhereBuilder` class; the update and delete builders still carry it at runtime through their `WhereBuilder` mixin, where it returns a plain `WhereBuilder` with their conditions, not a copy of the update or delete.
