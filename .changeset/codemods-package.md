---
"@spinajs/codemods": minor
"@spinajs/cli": minor
---

New package `@spinajs/codemods` (ts-morph) and the `spinajs upgrade --to 4 [--dry-run]` command in `@spinajs/cli`. The 4.0 transforms rewrite `@spinajs/<pkg>/lib/mjs/...` imports to `lib/`, remove `DI.setESMModuleSupport()` and the `typeof module` cjs/mjs switch, and add a TODO above `@HandleException` usages. `@spinajs/codemods` is an optional peer dependency of `@spinajs/cli`: install it to use `upgrade`.
