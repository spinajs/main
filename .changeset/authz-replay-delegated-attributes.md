---
"@spinajs/authz-ir": patch
---

A replay holds `principal.attributes` only when every principal of the record's delegation chain has its captured state decoded, not just the top one: a caveat evaluated for a delegate whose state is missing is `unknown` instead of reading no attributes.
