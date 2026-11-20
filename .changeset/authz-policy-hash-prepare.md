---
"@spinajs/authz": minor
---

`PolicyHashSource.prepare?(domain, service)` is awaited once a domain with a decision log has booted, before its service resolves, so the source knows the hash before the first record; a failure is logged and records carry `'unknown'`. `AuthzService.irContext?(model)` gives the context a model's `toIR` compiles with (its `authz.<model>` config and the domain's permission registry), and `IRCompileContext.stored` (`'include'` by default, or `'opaque'`) says whether policy held in database stores is compiled or replaced by a `stored:<model>:<store>` term.
