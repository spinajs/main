---
"@spinajs/compiler": patch
---

`generate:config-types` no longer types a partly readable config schema narrower than it is. A schema member the compiler cannot evaluate drops its whole `anyOf`, `oneOf`, `enum`, `type` or tuple from the published schema, so the path is typed wider, not as the members that were read: the authn-oidc claim paths are no longer typed `null`. The objects of an `x-explicit: partial` schema stay open to keys the generator cannot see.
