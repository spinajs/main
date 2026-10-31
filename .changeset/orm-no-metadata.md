---
"@spinajs/orm": minor
"@spinajs/configuration": minor
"@spinajs/di": minor
"@spinajs/compiler": minor
---

Models and `@AutoinjectService` work in an app built without `emitDecoratorMetadata`. `@CreatedAt`, `@UpdatedAt`, `@SoftDelete`, `@Archived`, `@DateTime`, `@Bool` and `@Set` no longer fail when the class is defined; without metadata the check of the declared type does not run. `@HasMany`, `@HasManyToMany`, `@Virtual` and `@JunctionTable` take the class the property declares from `manifest.classProperties` when a relation is first built, through the new `declaredPropertyType` of `@spinajs/di`, and throw `ResolveException` naming the class and the property when nothing records it. They and `@AutoinjectService` count for `checkPendingProperties`, which `Orm.resolve()` runs too. Builds with metadata are unchanged.
