---
"@spinajs/compiler": patch
---

CFG010 is no longer reported for a configuration schema registered from another package's declaration (for example `@spinajs/http` registering `@spinajs/idempotency`'s schema from a lazy import): that package's own fragment records the schema.
