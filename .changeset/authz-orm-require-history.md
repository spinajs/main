---
"@spinajs/orm": minor
"@spinajs/orm-history": patch
"@spinajs/authz-orm": minor
---

`authz.orm.requireHistory` (default `false`): when it is `true`, `@spinajs/authz-orm` refuses with `UnrecordedResourceWrite`, before the statement runs, an insert, a delete, or an update of a relation column, a type column or the primary key of an `@AccessResource` model, unless a history-keeping write observer takes it and records every relation and type column of the model. A column-mode history that leaves a relation column out, an `exclude` that names one, or a masked `@Hidden()` relation column does not satisfy the key. `WriteObserver` gains the optional member `keepsHistory` and `CaptureInterest` the optional `unrecorded`; the row history observer of `@spinajs/orm-history` sets both.

The configuration section `authz.orm` now keeps only the keys its schema declares (`domain`, `accessField`, `requireHistory`, `rls`): any other key under it, an application's own included, is removed when the configuration is validated. Nothing logs the removal yet, so a misspelt `requireHistory` leaves the check off without a message.
