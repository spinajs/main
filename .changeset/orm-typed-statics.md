---
"@spinajs/orm": minor
---

`ModelBase.where` checks its column and value like the builder's `where`, and its object overload accepts the model's relations (`PickRelations` was computed over the class, which has none). The builder passed to the `first`, `last`, `newest`, `oldest` and `count` callbacks is typed with the model instance; it was typed with the model class, so its object form `where({ ... })` checked the wrong properties.

In strict mode, a builder without a model (`driver.select()`, `ISelectQueryBuilder<any>`) keeps its own type after `select`, `columns` and the aliased aggregates; it became the `ISelectQueryBuilder` interface, so a class chain lost `toDB(): ICompilerOutput`. The object form of `where`, `orWhere`, `andWhere` and `whereObject` checks the model's columns after a strict `columns([...])` or `select(...)`; it checked the projection and rejected unselected columns.
