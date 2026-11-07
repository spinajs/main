---
"@spinajs/orm": minor
---

`ModelBase.where` checks its column and value like the builder's `where`: in strict mode `User.where('Nmae', 1)`, `User.where('Id', '>', 'x')`, `User.where(name, '=', 1)` with `name: string`, and `User.where({ Email: 1 })` are compile errors. Its object overload accepts a partial model and the model's relations (`PickRelations` was computed over the class, which has none).

The builder passed to the `first`, `last`, `newest`, `oldest` and `count` callbacks is typed with the model instance; it was typed with the model class, so its object form `where({ ... })` checked the wrong properties. A callback annotated with the class type, `(b: IWhereBuilder<typeof User>) => ...`, no longer compiles in either mode: annotate it as `IWhereBuilder<User>` or drop the annotation.

In strict mode, a builder without a model (`driver.select()`, `ISelectQueryBuilder<any>`, `SelectQueryBuilder<any[]>`) keeps its own type after `select`, `columns` and the aliased aggregates; it became the `ISelectQueryBuilder` interface, so a class chain lost `toDB(): ICompilerOutput`. The object form of `where`, `orWhere`, `andWhere` and `whereObject` checks the model's columns after a strict `columns([...])` or `select(...)`; it checked the projection and rejected unselected columns.
