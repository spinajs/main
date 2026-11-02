---
"@spinajs/templates-pug": patch
---

`PugRenderer` loads `pug` the first time it compiles a template, not when the package is imported. `@spinajs/http` imports this package at startup, so pug and its `@babel/*` parser no longer load at boot.
