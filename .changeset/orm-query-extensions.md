---
"@spinajs/orm": minor
---

New builder extension point: `SelectQueryExtension`, `UpdateQueryExtension`, `DeleteQueryExtension` and `InsertQueryExtension` (all extending `QueryExtension`), `defineQueryExtension()`, `QueryExtensionDefinition`, `QueryTarget`, `BuilderState`, `QueryBuilder.state()` and `ExtensionMethodCollision`. Subclass the base of the builder you extend and register it with `@Injectable(<that base>)`; `Orm.resolve()` installs its methods on that builder before it opens a connection, and fails with `ExtensionMethodCollision` when a method name is taken. A subclass of a registered extension replaces it. `onClone` runs when a select builder is cloned. See `docs/orm/16-scopes-and-builder-extensions.md`.
