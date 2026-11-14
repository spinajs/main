---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

The access of a manifest entry point says more: an `AccessPolicy` ref lists its permissions and then `{ allowAnonymous?: true; resource?: { type } | { model } }` when `@AllowAnonymous` (or `@SocketAccess({ allowAnonymous })`) lets anonymous callers reach the check or a literal extractor (`fromParam`, `fromBody`, `fromQuery`, `fromPayload`, `typedExtractor`, `fromModel`) names the resource. A route with no guard records `@Public(reason)` or `@AllowAnonymous` as its access. A `consume(Event, handler)` entry takes the `@SystemTask(reason)` of the event class. `inheritSocketHandlers` gives a socket subclass the class-level `@SocketPolicy` / `@SocketAccess` of its base, as the runtime does (an own `@SocketAccess` replaces the inherited one), so the manifest of such a subclass gets a new hash on rebuild.
