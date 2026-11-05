# `@spinajs/authz-verify`

Verification of a `PolicyIR` from `@spinajs/authz-ir` (Bet 6 lane V). A development and CI tool: runtime code never imports it.

- `RewriteAutomaton`: the rewrite graph read as a finite automaton. States are `type#relation`, letters are the tuples a check walks, recursive `parent->` rewrites are cycles.
- `reachers(ir, permission)`: every holder (`role:<role>@<type>`, `<type>#<relation>`, `public:<type>#<relation>`) that can reach the permission, with its shortest path and that path's minimal tuple set.
- `permissionMatrix(ir)`: holder × permission → `always | conditional | never`, plus the opaque parts each permission depends on.
- `outcome(ir, scenario, permissions)`: re-runs a scenario through the reference `IREvaluator`.
