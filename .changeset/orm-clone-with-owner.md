---
"@spinajs/orm": minor
---

`SelectQueryBuilder.clone()` takes an optional owner relation, `clone(owner?)`. The ORM passes it when a query with a populated relation is cloned, so that the copy of the relation owns the clone of its query; it replaces an internal second clone function. **A subclass that overrides `clone()` must take the argument and pass it on (`super.clone(owner)`).** An override without it still compiles and drops the owner. `IWhereBuilder` no longer declares `clone(parent)`: the method stays on the `WhereBuilder` class, and the update and delete builders, which the interface also describes, never had it.
