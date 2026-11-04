---
"@spinajs/compiler": minor
---

The manifest `authz` section lists every entry point with its access: routes (`GET /users/:id`), socket commands and events (their full name), queue jobs (`job:<Class>`, every concrete `QueueJob` subclass, with the permissions of `@Job({ access })`), the handlers of literal `consume(Event, handler)` calls (`event:<Class>`), schedules and CLI commands. `access` is OR-of-AND policy groups with the class and handler scopes combined as the runtime combines them, an `AccessPolicy` group listing its permissions; `system` is the `@SystemTask(reason)` of the class. An app manifest with an `authz` section carries the info diagnostic `AUTHZ010`: the policy IR is not in the manifest yet, run `spinajs authz verify` with the configuration.
