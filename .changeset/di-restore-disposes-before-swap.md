---
"@spinajs/di": patch
---

`restore(snapshot)` disposes the children and the `Service`s cached since the snapshot before it puts the snapshot back, so a `dispose()` can still read its `@Config` properties, injections and registrations made after the snapshot. What disposal resolves or registers is still taken back.
