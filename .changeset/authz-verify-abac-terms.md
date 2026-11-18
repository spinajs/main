---
"@spinajs/authz-verify": patch
---

The exact engine models a rewrite that holds for every principal (`{ intersection: [] }`, what ABAC compiles a policy to): it is an accepting edge for anyone, conditional under a caveat, and its own holder `anyone:<type>#<relation>`, which the selector `public` matches. Before, `reachers`, `permissionMatrix`, `never`, `implies`, `onlyVia` and `separated` did not see ABAC policies and answered `holds`. `onlyVia`, and `isolated` for its exceptions, answer `unknown` (`AZV003`) when a listed holder is an anyone term the exact engine cannot decide. `permissionMatrix` also returns `everyone` (what every principal holds through such a term), and `accessOf(matrix, holder, permission)` reads a cell together with it, as `never(holder, permission)` does.
