---
"@spinajs/util": minor
"@spinajs/queue": minor
"@spinajs/cli": minor
"@spinajs/scheduler": minor
"@spinajs/authn-local": patch
"@spinajs/email-verification": patch
---

`@SystemTask(reason)` declares that a schedule, CLI command or queue job runs as SYSTEM and why; `systemTaskOf(Class)` reads it from the class itself (a subclass does not inherit it). It is exported by `@spinajs/util` and re-exported by `@spinajs/queue`, `@spinajs/cli` and `@spinajs/scheduler`, and the manifest records the reason on the entry point. An empty reason throws. `AuthnMailJob` and the email-verification domain list sync carry it.
