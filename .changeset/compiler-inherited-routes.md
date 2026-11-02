---
"@spinajs/compiler": minor
"@spinajs/manifest": minor
---

A controller's manifest entry now lists the routes it inherits from base classes of the same package, with the subclass's mount path, merged class guards and the generic types it binds, and records `bases` / `inheritedFrom`. A subclass without its own `@BasePath` is now recorded at the base path it inherits, as the runtime mounts it; before, the manifest used the subclass name. Rebuild the manifest after upgrading: request validation of an inherited route then uses the subclass's types (for `BaseCrud<T>` the bound DTO instead of `{}`), and the first `manifest:diff` against a manifest built before the upgrade shows the inherited routes as added and corrected paths as removed/added. An abstract class that declares only `@BasePath` or class guards is now kept in `controllerBases`. A type parameter is reported as `SCH001` info instead of a warning.

`spinajs build` records the compiler version as `compilerVersion` (`MergeMeta.compilerVersion`); `hashManifest` leaves it out like `generatedAt`, so a manifest without inheritance keeps its hash. When a subclass decorates an inherited route argument again, `inheritController` keeps the base's `runtimeType.ref`, as the runtime keeps the base's `RuntimeType`, and an overridden route keeps every field of the inherited one it does not merge.
