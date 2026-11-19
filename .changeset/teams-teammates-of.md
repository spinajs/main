---
"@spinajs/teams": minor
---

`TeamService.teammatesOf(principal, { roles })` lists the members of the principal's own teams: per team of `teamsOf`, the other principals holding one of `roles` (default `team.member`), with groups and sub-teams expanded. Like `teamsOf`, it reads the principal's own data without an authorization check.
