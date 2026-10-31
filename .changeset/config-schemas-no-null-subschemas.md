---
"@spinajs/compiler": patch
---

A configuration schema in the manifest no longer holds `null` where the compiler could not read a part. `literalValue` now follows array spreads and `Object.freeze`, so `enum: [...NAMES]` publishes its names instead of `enum: [null]`. What still cannot be read, such as a subschema built by a call, is left out and the schema is marked `x-explicit: 'partial'`, as an explicit `@Schema` already is. The `authn-oidc` and `authz-rbac` schemas, which Ajv refused, are valid again, and `DataValidator` stops logging them as invalid on a manifest boot. Rebuild to pick this up.
