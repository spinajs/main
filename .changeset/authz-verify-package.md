---
"@spinajs/authz-verify": minor
---

New package `@spinajs/authz-verify`, the development and CI verifier for the policy IR of `@spinajs/authz-ir`. `RewriteAutomaton` reads the IR's rewrites as a finite automaton whose letters are the tuples a check walks, so recursive `parent->` chains stay cycles. `reachers(ir, permission)` lists every holder (`role:<role>@<type>`, `<type>#<relation>`, `public:<type>#<relation>`) that can reach a permission, with its shortest path and the minimal tuple set that walks it, and `permissionMatrix(ir)` rates each holder against each permission as `always`, `conditional` (only through intersections, exclusions, caveats or priority chains) or `never`, listing the opaque parts each permission depends on.
