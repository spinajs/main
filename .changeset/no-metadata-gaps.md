---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/di": minor
"@spinajs/configuration": minor
"@spinajs/http": minor
"@spinajs/http-socket": minor
"@spinajs/http-swagger": patch
"@spinajs/testing": patch
---

More of an app that boots from a manifest works without `emitDecoratorMetadata`.

- The compiler records every decorated route parameter (`kind: 'Decorated'`, `wire.in: 'none'` for a decorator it does not know), `controllerBases` for controllers nothing mounts, `classProperties` keyed by entry id for a package built without metadata, and `diArgs` for socket `@FromDI()`. `typeof Foo`, globals Node does not provide and `declare class` record `Object`.
- `IPropertyTypeResolver.typeOf` is synchronous and returns `{ type, array }`. `@spinajs/configuration` loads the classes of `classProperties` in `Configuration.resolve()`, so the first resolve of a sync service stays sync. Two classes of one name that declare a property differently throw `ResolveException`. `@Autoinject(X)` and `@LazyInject(X)` on a list apply the list shape the manifest records.
- `@spinajs/http` and `@spinajs/http-socket` fill argument types on a copy, `BaseController.Routes` being what a boot serves, so boots in one process no longer share them. `routesWithRuntimeTypes` replaces `runtimeTypesFromManifest`; `routeEntryOf` takes the class lineage.
- Routes inherited from a base class are found through the class chain, and socket handlers through `socketControllerBases`. **This also changes builds with metadata in `prefer` and `require`:** an inherited route or socket handler now gets the derived validators of its argument types, as one the class declares itself does, so a request that passed before can answer 400. For a whole body the same validator also drops undeclared root keys from the argument: an inherited route's handler now gets only the declared ones, while `req.body` stays as sent. A concrete controller outside the declared dirs gets derived validators on its own routes too, because `controllerBases` holds it; in-tree this has no effect, it reaches third-party packages.
- `array` in `propertyInjects` comes from what the type resolves to, so an alias and `readonly T[]` inject the list. A route-arg that never reads its type records `Object` for a class the manifest cannot name; any other kind fails `require` with `refProblem` as the reason.
- `@spinajs/di` collects properties decorated without metadata, and `checkPendingProperties` runs after `Configuration`, after the controllers load and before socket handlers register. `require` fails listing every property the table lacks, also an explicit `@Autoinject(X)`; `prefer` logs a named error for each. **That includes an app built with metadata on a dependency built without it whose fragment has no table.** `require` is new in 4.x, so no existing app regresses.
- With no property type resolver registered, the `ResolveException` says to resolve `Configuration` first or pass the type.
- With no manifest to answer, an app that no longer throws at class definition logs a named error for each untyped argument at boot, instead of answering 500 on every request with no signal. `@Parameter()` itself tolerates the missing metadata since the previous change.
