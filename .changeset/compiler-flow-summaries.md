---
"@spinajs/compiler": minor
---

`summarize(graph, checker, roots)` in the authz flow pass (`src/flow`, used by the manifest build; the package root keeps the doctor's `summarize`): the authz effects (multi-row and single-row reads, updates, deletes of models, and other model statics such as inserts and counts, with their scoping) of every function reachable from the roots, across helpers, injected services, overrides and `DI.resolve`, with `runAs(SYSTEM, reason)` exempting its callback. A builder under `?:`, `??`, `||` or `&&`, one the tracer can only read from its type, and one a root returns to the framework are all counted. It returns how many calls and handed-on function values it could not follow (`opaqueCalls`) and how many went into dependencies (`externalCalls`). A function passed by name runs the builders it is handed, and a TypeScript `this` parameter does not shift the arguments a call hands on.
