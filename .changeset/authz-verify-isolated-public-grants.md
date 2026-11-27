---
"@spinajs/authz-verify": patch
---

`isolated(type)` counts public grants (`user:*`). A policy where everyone may reach a tenant, or a resource under one, passed `isolated` before and now fails `spinajs authz:verify` with `AZV001` (exit 1) and a counterexample naming the wildcard tuple. Review those grants; where public access is intended, write `isolated(type, { except: ['public'] })`, or `public:<type>#<relation>` for one relation.
