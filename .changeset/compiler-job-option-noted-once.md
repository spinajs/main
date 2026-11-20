---
"@spinajs/compiler": patch
---

A `@Job` option that is not a literal gets one CMP001 note instead of three. The tenancy section reads the `tenancy` option from the extracted queue message, so `TenancyInputs` gains a `queueMessages` member, and the authz section no longer notes the options it evaluates again.
