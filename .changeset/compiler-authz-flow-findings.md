---
"@spinajs/compiler": minor
"@spinajs/manifest": minor
---

The authz flow pass: `spinajs build` follows every entry point (routes, socket commands and events, queue handlers, schedules, CLI commands) through helpers, injected services, overrides and `DI.resolve`, and records `AUTHZ001` (unscoped multi-row read of an access resource), `AUTHZ002` (unscoped update or delete builder) and `AUTHZ006` (`runAs(SYSTEM)` without a literal reason) in the manifest's `authz.findings`, each with its call path. `AuthzSection.flow` is new and required: the entry points analysed and what the pass could not follow (`unresolvedRoots`, `opaqueCalls`, `externalCalls`, `foreignModelQueries`). A manifest built by an older compiler no longer validates; rebuild it.
