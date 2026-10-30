---
"@spinajs/di": major
---

`container.snapshot()` / `container.restore(snapshot)` and `DI.snapshot()` / `DI.restore()`: restore disposes the children created and every `Service` cached since the snapshot (newest first, while the state they were created in is still live, so `dispose()` can read `@Config` and injections), then puts the registrations, values, cache and listeners back. When resolutions keep starting during disposal, restore still puts the state back, then rejects with `RestoreIncomplete` naming what is still resolving; a resolution that finishes after a restore is disposed and rejected instead of cached. `getCacheStats()` is part of `IContainer` now.
