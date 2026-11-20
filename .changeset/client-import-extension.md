---
"@spinajs/client": minor
"@spinajs/cli": minor
---

`generateClientFiles` takes `importExtension` (`'js'`, the default, `'ts'` or `'none'`) for how the generated files import each other, and `fileExtension` (`'.ts'` or `'.mts'`). `spinajs generate:client` has `--import-extension <js|ts|none>`, and an `--out` ending in `.mts` writes `.mts` files that import each other as `.mjs`.
