---
"@spinajs/compiler": minor
---

`summarize(graph, checker, roots)`: the authz effects (multi-row and single-row reads, updates, deletes of models, and other model statics such as inserts and counts, with their scoping) of every function reachable from the roots, across helpers, injected services, overrides and `DI.resolve`, with `runAs(SYSTEM, reason)` exempting its callback. A builder under `?:`, `??`, `||` or `&&`, one the tracer can only read from its type, and one a root returns to the framework are all counted. It returns how many calls and handed-on function values it could not follow (`opaqueCalls`) and how many went into dependencies (`externalCalls`).
