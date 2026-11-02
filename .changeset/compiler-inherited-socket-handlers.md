---
"@spinajs/compiler": minor
---

A socket controller's manifest entry now lists the commands, events and `@FromDI()` arguments it inherits, with the payload and result types its subclass binds, and records `bases`, `inheritedFrom` and `payloadIndex`. AsyncAPI, the generated client and `manifest:diff` see inherited socket handlers.

Every command and event now records `payloadIndex` when it has a `@Payload` argument, and every event records its method as `handler`, so the manifest of any app with socket handlers gets a new hash on rebuild. A base read from a dependency's fragment is re-typed through these fields; an event from a fragment built before this release keeps the payload type its package recorded. After a rebuild, the payload of an inherited generic handler (`CrudSocket<T>` bound to `Hello`) is validated against the bound type; before, the schema derived from `T` accepted any value.
