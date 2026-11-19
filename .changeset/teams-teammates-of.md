---
"@spinajs/teams": minor
---

`TeamService.teammatesOf(principal, { roles })` lists, per team of `teamsOf`, the other principals holding one of `roles` (default `team.member`) at the team, expanding groups and sub-teams that hold it. Like `teamsOf` it reads the principal's own data without a check, so a session ceiling that drops the team roles does not hide them.
