---
"@spinajs/orm": patch
---

`src/builders.ts` is split into `src/builders/*.ts`, one file per builder family, by `packages/orm/scripts/split-builders.mjs`. `builders.ts` re-exports them; the package's exports are unchanged.
