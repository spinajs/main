---
"@spinajs/di": major
---

ESM-only: every package builds into `lib/` (was `lib/mjs` + `lib/cjs`). `exports` no longer has a `require` condition; deep imports of `@spinajs/<pkg>/lib/mjs/...` become `@spinajs/<pkg>/lib/...` (`spinajs upgrade --to 4` rewrites them).
