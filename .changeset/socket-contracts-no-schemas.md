---
"@spinajs/manifest": minor
"@spinajs/compiler": minor
"@spinajs/http-socket": minor
---

A manifest built with `spinajs build --no-schemas` records `schemaDerivation: false`. An app that binds socket contracts with such a manifest used to run them unvalidated in silence. Now a `require` boot fails, naming the contracts whose payloads have no schema, and `prefer` logs one warning per boot naming them. `off` is unchanged.
