---
"@spinajs/di": major
---

`container.snapshot()` / `container.restore(snapshot)` and `DI.snapshot()` / `DI.restore()`: restore disposes the children and every `Service` cached since the snapshot (newest first, while the state they were created in is still live, so `dispose()` can read `@Config` and injections), then puts the registrations, values, cache and listeners back. `getCacheStats()` is part of `IContainer` now.
