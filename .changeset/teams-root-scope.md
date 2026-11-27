---
"@spinajs/teams": minor
---

`@spinajs/teams`: the port `TeamRootScope` says where root teams hang and where `team:create` is checked for one (default `$global`, unchanged). An app that imports `@spinajs/tenancy` and uses `@spinajs/teams` fails to boot after the upgrade until it sets `teams.tenancy: false` (teams stay global: a team can hold users of several tenants). The authz domain boot checks it (`TeamsTenancyCheck`): an HTTP app fails when the server starts listening, a worker or a CLI at the first team operation the authz service checks. `true` (teams inside tenants) needs `@spinajs/tenancy-orm/teams`, which comes in a later release; until then it refuses the boot too.
