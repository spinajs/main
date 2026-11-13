---
"@spinajs/orm": major
"@spinajs/orm-http": minor
"@spinajs/http-swagger": minor
"@spinajs/users": minor
"@spinajs/users-http": major
---

Strict query typing has no unchecked escape hatches any more, and sorting and includes from a request are validated by the framework instead of by hand.

- `@spinajs/orm`: `col()`, `rel()`, `ColumnLiteral` and `RelationLiteral` are removed. In strict mode a column the model does not declare is written `table.column`, and a name known only at runtime is narrowed to `ColumnName<M>` / `RelationName<M>` by a check (or comes from `@Sort` / `@Include`). The object form `order({ column, order })` is checked like `order(column, direction)` (`ColumnSort<M>`). New `@Sortable()` marks the columns a request may sort by (`IModelDescriptor.Sortable`, a required field: a hand-written `IModelDescriptor` needs `Sortable: []`).
- `@spinajs/orm-http`: `@Sort(Model, { default, order?, field? })` reads the `order` query parameter (`{"column":"Login","order":"desc"}`), accepts only the model's `@Sortable()` columns and returns `Sort<M>` (`column: ColumnName<M>`); a bad column or direction answers 400, a missing one takes the default. A `default` that is not sortable, or a model without sortable columns, throws when the controller is defined. `@Include(Model, ['Metadata'])` reads `include` (single value, repeated keys or a JSON array), accepts only the listed relations (typed `RelationName<M>[]`) and returns them ready for `populate()`. `readSort` and `Sort` are generic over the model.
- `@spinajs/http-swagger`: documents `@Sort` (column and direction enums, defaults) and `@Include` (array enum) parameters.
- `@spinajs/users`: `User` declares `Uuid`, `Login`, `Email`, `IsActive`, `CreatedAt`, `LastLoginAt` and `DeletedAt` `@Sortable()`.
- `@spinajs/users-http`: the admin `Users` controller sorts with `@Sort(User, ...)` and includes with `@Include(User, ['Metadata'])`. The protected `sortColumn(order)` hook is removed, and `list(caller, sort, include, pagination, filter)` takes its arguments in that order; a subclass that overrode `sortColumn` or calls `list` directly must be updated. A single `?include=Metadata` is now accepted on the list and single-user routes. A bad sort column answers a `ValidationFailed` 400 instead of `InvalidArgument` "Cannot sort by ...".
