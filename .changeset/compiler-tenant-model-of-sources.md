---
"@spinajs/compiler": patch
---

`registerTenantModel` and `registerAccessResource` of a model of another package record it under that package's name also when the program resolves the package to its sources (path mappings, project references, `allowJs`) instead of its `.d.ts`; a tenant model registered that way was left out before. A model is of another package when the nearest named `package.json` above its declaration is not the analysed package's.
