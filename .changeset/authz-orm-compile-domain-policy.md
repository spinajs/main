---
"@spinajs/authz-orm": minor
---

`compileDomainPolicy(domain, service, { stored })` compiles a booted domain's models, the `@AccessResource` relations (`ormToIR`) and the domain's `authz.combine` into the policy IR, with its canonical text and hash.
