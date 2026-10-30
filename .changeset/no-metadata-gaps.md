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
- Routes inherited from a base class are found through the class chain. **This also changes builds with metadata in `prefer` and `require`:** an inherited route now gets the derived validators of its argument types, as a route the class declares itself does.
- With no manifest to answer, an app that no longer throws at class definition logs a named error for each untyped argument at boot, instead of answering 500 on every request with no signal. `@Parameter()` itself tolerates the missing metadata since the previous change.
