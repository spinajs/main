---
"@spinajs/manifest": patch
---

`publishedManifest` keeps a subclass outside `system.dirs` (`mountedBy`) that is registered with an unconditional `DI.register(Sub).as(Base)` over a controller the manifest loads, because the runtime serves the subclass in that controller's slot. OpenAPI, the client and `manifest:diff` used to leave out both. When two such subclasses replace one base, both stay out, as only a boot tells which one serves. This is a static guess: it assumes the module that holds the registration runs, and if nothing imports it the base serves instead.
