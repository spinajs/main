---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/http": patch
---

`publishedManifest` (OpenAPI, AsyncAPI, the client, `manifest:diff`) leaves out a controller that a subclass replaces with an unconditional `DI.register(Sub).as(Base)`, as the runtime mounts only the subclass; `overriddenControllers` is exported. Doctor HTTP001 skips such a controller, and HTTP001-HTTP005 report an inherited route at the subclass with `(inherited from <base>)`. Inherited routes are now checked by doctor: a subclass of a guard-less base (such as `UploadController`) without `@Access`, `@Policy`, `@AllowAnonymous` or `@Public` now fails HTTP002.

`diffManifest` returns `warnings` when base and head were built by different `@spinajs/compiler` versions (`compilerVersion`), or only one of them records it, and `renderMarkdown` prints each under the result line. The first diff after upgrading the compiler shows inherited routes as added and corrected base paths as removed and added: rebuild the base manifest with the new compiler to compare like with like. The field is absent when there is nothing to warn about.
