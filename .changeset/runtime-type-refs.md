---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

The compiler records runtime type references: `TypeRef.ref` on route arguments and socket payloads (what `emitDecoratorMetadata` would record: a global constructor such as `Number`, or the export of a class in the package or in a dependency with a manifest fragment), and `propertyInjects[].tokenRef` for `@Autoinject()` / `@LazyInject()` properties that name no type. Controllers and socket controllers now carry `propertyInjects` too. A class the runtime could not import gets no `ref` and an info diagnostic, `TYP001` (not exported) or `TYP002` (no manifest fragment, or an ambient module). `resolveTypeRef(ref, manifest)` in `@spinajs/manifest` imports a reference through `manifestFileFor`, memoised per manifest. Additive: `MANIFEST_VERSION` stays 2.
