---
"@spinajs/compiler": patch
---

CFG010 is no longer reported for a configuration schema declared in a `.d.ts` of another package that ships a manifest fragment (for example `@spinajs/http` registering `@spinajs/idempotency`'s schema from a lazy import): that package's own build recorded the schema. A schema declared in a `.d.ts` of the package itself or of a package without a fragment still warns.
