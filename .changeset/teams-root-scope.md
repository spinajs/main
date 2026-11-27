---
"@spinajs/teams": minor
---

`@spinajs/teams`: the port `TeamRootScope` says where root teams hang and where `team:create` is checked for one (default `$global`, unchanged). `teams.tenancy` (boolean) must be set when `@spinajs/tenancy` is imported, and must agree with the root scope a bridge registers; the authz domain boot checks it (`TeamsTenancyCheck`).
