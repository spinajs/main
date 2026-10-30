---
"@spinajs/reflection": minor
---

`TypescriptCompiler` moved to the `@spinajs/reflection/typescript` subpath, so importing `@spinajs/reflection` no longer loads `typescript`. `glob` is imported on the first directory scan, never when listing from the manifest.
