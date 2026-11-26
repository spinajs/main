---
"@spinajs/orm": minor
"@spinajs/orm-history": patch
"@spinajs/authz-orm": minor
---

`authz.orm.requireHistory` (default `false`): when it is `true`, `@spinajs/authz-orm` refuses with `UnrecordedResourceWrite`, before the statement runs, an insert, a delete, or an update of a relation column, a type column or the primary key of an `@AccessResource` model that no history-keeping write observer records. `WriteObserver` gains the optional member `keepsHistory`, which the row history observer of `@spinajs/orm-history` sets.

The configuration section `authz.orm` now keeps only the keys its schema declares (`domain`, `accessField`, `requireHistory`, `rls`): any other key under it is removed when the configuration is validated, so a misspelt key no longer stays in the configuration unread.
