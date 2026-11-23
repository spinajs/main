---
"@spinajs/authz-ir": minor
---

`compilePolicy(service, options)` compiles a booted domain's models (with `AuthzService.irContext`), extra fragments and its `authz.combine` into the policy IR and returns it with its canonical text and SHA-256 hash; `stored` defaults to `'opaque'`, so the hash covers config-declared policy only. `combineFromConfig` maps `authz.combine` to `CombineIR` (custom combinators become opaque). `storedPolicyName(model, store)` names the opaque term that stands for the policy a database store holds.
